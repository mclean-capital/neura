import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="text-3xl">!</span>
          <p className="text-dark-muted-light text-sm">Something went wrong</p>
          <p className="text-dark-muted text-xs font-mono max-w-sm break-words">
            {this.state.error.message}
          </p>
          <button
            className="px-6 py-2 rounded-full border border-dark-border text-dark-muted-light text-sm cursor-pointer hover:border-accent hover:text-accent transition-colors"
            onClick={() => this.setState({ error: null })}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
