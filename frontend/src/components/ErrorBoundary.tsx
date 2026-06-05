import { Component, type ErrorInfo, type ReactNode } from 'react'

type State = { error: Error | null; info: ErrorInfo | null }

// SPEC §13 hardening: catch render errors that would otherwise leave a blank
// page. Shows the error message + stack on screen so we don't have to chase
// blank screens through DevTools.
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info })
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="min-h-screen p-8 font-mono text-[12px] text-ink">
        <h1 className="font-display text-2xl mb-3 text-negative">Runtime error</h1>
        <div className="mb-4">
          <div className="label-eyebrow mb-1">Message</div>
          <div className="whitespace-pre-wrap">{this.state.error.message}</div>
        </div>
        <div className="mb-4">
          <div className="label-eyebrow mb-1">Stack</div>
          <pre className="whitespace-pre-wrap text-[11px] text-muted">
            {this.state.error.stack}
          </pre>
        </div>
        {this.state.info && (
          <div>
            <div className="label-eyebrow mb-1">Component stack</div>
            <pre className="whitespace-pre-wrap text-[11px] text-muted">
              {this.state.info.componentStack}
            </pre>
          </div>
        )}
      </div>
    )
  }
}
