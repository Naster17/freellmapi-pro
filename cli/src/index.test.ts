import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeLaunchEnv, codexArgs, parseArgs } from './index.js';
import type { CatalogModel } from './types.js';

describe('CLI arguments and launchers', () => {
  it('parses setup options before or after the command', () => {
    expect(parseArgs([
      '--url',
      'http://localhost:3001/v1',
      'setup-codex',
      '--profile=work',
      '--dry-run',
    ])).toMatchObject({
      command: 'setup-codex',
      options: {
        url: 'http://localhost:3001/v1',
        profile: 'work',
        dryRun: true,
      },
    });
  });

  it('rejects profile names that can escape the intended config directory', () => {
    expect(() => parseArgs(['setup-codex', '--profile', '../../outside']))
      .toThrow('--profile must use only');
    expect(() => parseArgs(['setup-codex', '--profile', '..']))
      .toThrow('--profile must use only');
  });

  it('rejects a missing option value instead of consuming the next flag', () => {
    expect(() => parseArgs(['setup-codex', '--profile', '--dry-run']))
      .toThrow('--profile requires a value');
  });

  const models: CatalogModel[] = [
    { id: 'auto' },
    { id: 'fast-coder', available: true, context_window: 131072 },
    { id: 'reasoning-model', available: true, context_window: 262144 },
  ];
  const baseOptions = {
    url: 'http://localhost:3000',
    profile: 'default',
    dryRun: false,
  };
  const temporary: string[] = [];

  afterEach(() => {
    for (const directory of temporary.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses --model for ANTHROPIC_MODEL and defaults to the first available model', () => {
    const explicit = claudeLaunchEnv(
      { ...baseOptions, model: 'reasoning-model' },
      'unified-key',
      models,
      {},
      '/home/tester',
    );
    expect(explicit.ANTHROPIC_MODEL).toBe('reasoning-model');
    expect(explicit.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');

    const fallback = claudeLaunchEnv(baseOptions, 'unified-key', models, {}, '/home/tester');
    expect(fallback.ANTHROPIC_MODEL).toBe('fast-coder');
    expect(fallback.ANTHROPIC_AUTH_TOKEN).toBe('unified-key');
    expect(fallback.ANTHROPIC_BASE_URL).toBe('http://localhost:3000');
  });

  it('never uses the profile name as a model id', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-cli-'));
    temporary.push(home);
    const profileDir = path.join(home, '.claude', 'profiles', 'work');
    fs.mkdirSync(profileDir, { recursive: true });
    const env = claudeLaunchEnv(
      { ...baseOptions, profile: 'work' },
      'unified-key',
      models,
      {},
      home,
    );
    expect(env.ANTHROPIC_MODEL).toBe('fast-coder');
    expect(env.CLAUDE_CONFIG_DIR).toBe(profileDir);
  });

  it('rejects a profile whose configuration directory does not exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-cli-'));
    temporary.push(home);
    expect(() => claudeLaunchEnv(
      { ...baseOptions, profile: 'missing' },
      'unified-key',
      models,
      {},
      home,
    )).toThrow("freellmapi setup-claude --profile missing");
  });

  it('strips the user\'s real Anthropic credentials from the child environment', () => {
    const env = claudeLaunchEnv(baseOptions, 'unified-key', models, {
      ANTHROPIC_API_KEY: 'real-anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'real-anthropic-token',
      PATH: '/usr/bin',
    }, '/home/tester');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('unified-key');
    expect(env.PATH).toBe('/usr/bin');
    expect(JSON.stringify(env)).not.toContain('real-anthropic');
  });

  it('passes a complete Responses provider to Codex', () => {
    const args = codexArgs('http://localhost:3001/v1/', 'coder');
    expect(args).toContain('model_provider="freellmapi"');
    expect(args).toContain('model="coder"');
    expect(args).toContain('model_providers.freellmapi.name="FreeLLMAPI"');
    expect(args).toContain(
      'model_providers.freellmapi.base_url="http://localhost:3001/v1"',
    );
    expect(args).toContain('model_providers.freellmapi.wire_api="responses"');
  });
});
