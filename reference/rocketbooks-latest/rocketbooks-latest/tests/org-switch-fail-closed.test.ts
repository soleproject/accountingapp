import assert from 'node:assert/strict';

class FakeElement {
  id = '';
  inert = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = '';
  parent: FakeBody | null = null;
  attributes: Record<string, string> = {};

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

class FakeBody {
  children: FakeElement[] = [];

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
}

const body = new FakeBody();
const app = new FakeElement();
const previouslyInert = new FakeElement();
previouslyInert.inert = true;
body.appendChild(app);
body.appendChild(previouslyInert);
const replacements: string[] = [];
let replacementThrows = false;

Object.assign(globalThis, {
  HTMLElement: FakeElement,
  document: {
    body,
    createElement: () => new FakeElement(),
    getElementById: (id: string) => body.children.find((child) => child.id === id) ?? null,
  },
  window: {
    location: {
      href: 'https://app.rocketsuite.ai/dashboard',
      replace: (url: string) => {
        if (replacementThrows) throw new Error('navigation failed');
        replacements.push(url);
      },
    },
  },
});

async function main() {
  const {
    blockDocumentForOrganizationSwitch,
    replaceDocumentAfterOrganizationSwitch,
    unblockDocumentAfterOrganizationSwitchFailure,
  } = await import('../lib/auth/org-switch-client');

  blockDocumentForOrganizationSwitch();
  assert.equal(app.inert, true, 'old organization document must become inert before the switch request');
  const blocker = body.children.find((child) => child.id === 'rocket-suite-org-switch-blocker');
  assert.ok(blocker, 'a recovery interstitial must remain outside the inert application');
  assert.match(blocker.textContent, /reload this page to continue safely/i);

  replaceDocumentAfterOrganizationSwitch();
  assert.deepEqual(replacements, ['https://app.rocketsuite.ai/dashboard']);
  assert.equal(app.inert, true, 'a canceled replacement navigation must leave the old organization document inert');
  assert.ok(body.children.includes(blocker), 'a canceled replacement navigation must retain recovery guidance');

  replacementThrows = true;
  replaceDocumentAfterOrganizationSwitch();
  assert.equal(app.inert, true, 'a throwing replacement navigation must leave the committed old document inert');
  assert.ok(body.children.includes(blocker), 'a throwing replacement navigation must retain recovery guidance');

  unblockDocumentAfterOrganizationSwitchFailure();
  assert.equal(app.inert, false, 'a failed switch request must restore the original document');
  assert.equal(previouslyInert.inert, true, 'failure recovery must preserve elements that were already inert');
  assert.equal(body.children.some((child) => child.id === 'rocket-suite-org-switch-blocker'), false, 'failed switch must remove the blocker');

  console.log('org-switch-fail-closed: old scope stays inert after successful switch until replacement; request failure restores it');
}

void main();
