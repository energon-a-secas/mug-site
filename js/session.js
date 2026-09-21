// ── The page's connection: Convex client, who is signed in, whether they are admin ──
//
// One per page, made on first use. Anonymous visitors download nothing from
// Clerk (the Auth Kit guarantees that); the Convex client is fetched only
// when a page actually needs data. On localhost a dev token from
// scripts/dev-auth.mjs replaces the Auth Kit, because the production Clerk
// key refuses localhost (docs/architecture/auth-flow.md).

import { FN, clerkKeyFrom, convexUrlFor, devTokenFor, loadClient } from './backend.js';

function storage(kind) {
  try {
    const s = kind === 'session' ? window.sessionStorage : window.localStorage;
    return { getItem: (k) => s.getItem(k), setItem: (k, v) => s.setItem(k, v), removeItem: (k) => s.removeItem(k) };
  } catch {
    return null;
  }
}

let current = null;

/** A failure a page can show: the server's own code and sentence when there is one. */
export function failure(err) {
  const text = String(err && err.message ? err.message : err);
  if (/fetch|network|Failed to/i.test(text)) return { ok: false, code: 'network', message: 'Could not reach the catalogue. Check your connection and try again.' };
  return { ok: false, code: 'server', message: 'Something went wrong on our side. Try again in a moment.' };
}

export function connect() {
  if (!current) current = open();
  return current;
}

async function open() {
  const listeners = new Set();
  const state = {
    connected: false,
    url: null,
    client: null,
    signedIn: false,
    isAdmin: false,
    dev: null,
    label: null,
    ready: false,
  };
  const emit = () => listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error('mug: a session listener threw', err);
    }
  });

  let url = null;
  try {
    url = convexUrlFor(document, location, storage('local'));
  } catch (err) {
    console.error(err);
  }
  const api = {
    state,
    onChange(fn) {
      listeners.add(fn);
      if (state.ready) fn(state);
      return () => listeners.delete(fn);
    },
    async query(name, args = {}) {
      if (!state.client) throw new Error('not connected');
      return await state.client.query(name, args);
    },
    /** Mutations and actions answer { ok } values (CONTRACTS C6); a thrown error becomes one too. */
    async mutation(name, args = {}) {
      if (!state.client) return { ok: false, code: 'not-connected', message: 'The catalogue is not connected.' };
      try {
        return await state.client.mutation(name, args);
      } catch (err) {
        console.error(err);
        return failure(err);
      }
    },
    async action(name, args = {}) {
      if (!state.client) return { ok: false, code: 'not-connected', message: 'The catalogue is not connected.' };
      try {
        return await state.client.action(name, args);
      } catch (err) {
        console.error(err);
        return failure(err);
      }
    },
    async requireSignIn() {
      return state.signedIn;
    },
  };

  if (!url) {
    state.ready = true;
    paintAdminLink(false);
    return api;
  }
  state.url = url;
  state.client = await loadClient(url);
  state.connected = true;

  const refreshAdmin = async () => {
    try {
      const who = await state.client.query(FN.admin.whoami, {});
      state.isAdmin = !!who.isAdmin;
    } catch {
      state.isAdmin = false;
    }
    paintAdminLink(state.isAdmin);
  };

  const dev = devTokenFor(location, storage('session'));
  if (dev) {
    state.dev = dev;
    state.client.setAuth(dev.token);
    state.signedIn = true;
    state.label = dev.name || dev.subject;
    paintDevChip(state.label);
    api.requireSignIn = async () => true;
    await refreshAdmin();
    state.ready = true;
    emit();
    return api;
  }

  if (clerkKeyFrom(document)) {
    const { NeoAuth } = await import('./neorgon-auth.js');
    api.requireSignIn = (options = {}) => NeoAuth.requireSignIn(options);
    NeoAuth.onChange(async ({ signedIn, label }) => {
      state.signedIn = !!signedIn;
      state.label = label || null;
      await refreshAdmin();
      state.ready = true;
      emit();
    });
    await NeoAuth.start({ convex: state.client, siteName: 'Mug' });
  } else {
    state.ready = true;
    emit();
  }
  return api;
}

function paintAdminLink(isAdmin) {
  const link = document.getElementById('adminLink');
  if (link) link.hidden = !isAdmin;
}

function paintDevChip(label) {
  const slot = document.querySelector('[data-neo-auth]');
  if (!slot) return;
  slot.hidden = false;
  slot.textContent = '';
  const chip = document.createElement('span');
  chip.className = 'dev-chip';
  chip.title = 'Signed in with a local dev token (scripts/dev-auth.mjs). Production never accepts it.';
  chip.textContent = `Dev: ${label}`;
  slot.appendChild(chip);
}
