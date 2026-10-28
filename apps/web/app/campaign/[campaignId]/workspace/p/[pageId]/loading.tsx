// Shown the moment a page is clicked, while it loads: the click registers at once instead of
// the old page sitting there until the new one arrives.

export default function PageLoading() {
  return (
    <article className="ws-page" aria-busy="true" aria-label="Loading page">
      <div className="ws-skeleton ws-skeleton-crumbs" />
      <div className="ws-skeleton ws-skeleton-title" />
      <div className="ws-skeleton ws-skeleton-line" />
      <div className="ws-skeleton ws-skeleton-line" />
      <div className="ws-skeleton ws-skeleton-line short" />
    </article>
  );
}
