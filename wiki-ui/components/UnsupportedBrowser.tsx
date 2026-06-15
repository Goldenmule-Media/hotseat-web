/**
 * Shown when this browser lacks the module SharedWorker wiki-ui requires. By deliberate scope
 * (feature: shared engine in a SharedWorker) there is NO fallback — we fail loudly with a
 * clear message rather than degrade. No engine/PGlite is constructed on this path.
 */
export function UnsupportedBrowser(): React.JSX.Element {
  return (
    <main className="landing">
      <header className="landing-header">
        <h1>Hotseat Wiki</h1>
      </header>
      <div className="notice error">
        <strong>This browser isn&apos;t supported</strong>
        <p className="muted">
          Hotseat Wiki runs its engine in a single <code>{"{type:\"module\"}"}</code> SharedWorker shared across all
          tabs, which this browser doesn&apos;t support. Use a recent <strong>Chrome</strong> or{" "}
          <strong>Edge</strong>, <strong>Firefox 114+</strong>, or <strong>Safari 16+</strong>.
        </p>
      </div>
    </main>
  );
}
