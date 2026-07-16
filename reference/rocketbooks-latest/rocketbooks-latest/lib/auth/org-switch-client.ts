'use client';

const BLOCKER_ID = 'rocket-suite-org-switch-blocker';
const INERT_MARKER = 'orgSwitchInert';

export function blockDocumentForOrganizationSwitch() {
  if (document.getElementById(BLOCKER_ID)) return;

  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.inert) continue;
    child.inert = true;
    child.dataset[INERT_MARKER] = 'true';
  }

  const blocker = document.createElement('div');
  blocker.id = BLOCKER_ID;
  blocker.setAttribute('role', 'status');
  blocker.setAttribute('aria-live', 'assertive');
  blocker.textContent = 'Switching business… If this takes more than a few seconds, reload this page to continue safely.';
  Object.assign(blocker.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'grid',
    placeItems: 'center',
    padding: '2rem',
    background: 'rgba(9, 9, 11, 0.88)',
    color: '#fff',
    font: '600 1rem/1.5 system-ui, sans-serif',
    textAlign: 'center',
  });
  document.body.appendChild(blocker);
}

export function unblockDocumentAfterOrganizationSwitchFailure() {
  document.getElementById(BLOCKER_ID)?.remove();
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child.dataset[INERT_MARKER] !== 'true') continue;
    child.inert = false;
    delete child.dataset[INERT_MARKER];
  }
}

export function replaceDocumentAfterOrganizationSwitch() {
  try {
    window.location.replace(window.location.href);
  } catch {
    // The server scope has already changed. Keep the old document inert and
    // leave the recovery interstitial visible so the user can reload safely.
  }
}
