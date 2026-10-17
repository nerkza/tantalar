import "./BrandLogo.css";

/** Supplied artwork; the active application scheme selects the treatment. */
export function BrandLogo() {
  return (
    <span className="tantalar-logo" role="img" aria-label="Tantalar">
      <img className="tantalar-logo__dark" src="/brand/logo-dark.svg" width="890" height="220" alt="" />
      <img className="tantalar-logo__light" src="/brand/logo-light.svg" width="890" height="220" alt="" />
    </span>
  );
}
