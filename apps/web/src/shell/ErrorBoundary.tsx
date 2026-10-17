import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey?: string;
  readonly title?: string;
  readonly actionLabel?: string;
  readonly onReset?: () => void;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

/** A safe recovery surface for render failures. Error details stay in logs. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Tantalar interface failure", error, info.componentStack);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  private readonly reset = (): void => {
    this.setState({ failed: false });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <section className="tantalar-error-boundary" role="alert" data-testid="error-boundary">
        <h1>{this.props.title ?? "This page could not be displayed"}</h1>
        <p>Your data is safe. Try again, or return to a known working page.</p>
        <button type="button" onClick={this.reset}>
          {this.props.actionLabel ?? "Try again"}
        </button>
      </section>
    );
  }
}
