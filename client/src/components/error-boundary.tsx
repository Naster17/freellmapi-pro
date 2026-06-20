import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[client] Unhandled render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="rounded-3xl border bg-card p-6 text-center shadow-sm">
        <p className="text-sm font-medium">Something went wrong.</p>
        <p className="mt-2 text-xs text-muted-foreground">
          The dashboard caught a UI error instead of crashing the whole app.
        </p>
        <Button className="mt-4" size="sm" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    )
  }
}
