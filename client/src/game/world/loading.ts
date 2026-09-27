import * as THREE from 'three'

/**
 * Everything the battle needs is counted while it loads (models, textures, the sky, the ground photos), so the
 * game can hold a loading screen until the last file is in. three.js' loaders report to the default manager;
 * files fetched by hand are counted with `trackLoad`.
 */
const state = { loaded: 0, total: 0, lastChange: 0 }
const manager = THREE.DefaultLoadingManager
// Count starts and finishes ourselves (the manager only reports finishes)
const itemStart = manager.itemStart.bind(manager)
const itemEnd = manager.itemEnd.bind(manager)
const itemError = manager.itemError.bind(manager)
manager.itemStart = (url: string) => { state.total++; state.lastChange = performance.now(); itemStart(url) }
manager.itemEnd = (url: string) => { state.loaded++; state.lastChange = performance.now(); itemEnd(url) }
manager.itemError = (url: string) => { state.lastChange = performance.now(); itemError(url) }

/** Count a hand-made load (a fetch) like the loaders' own. */
export function trackLoad<T>(url: string, work: Promise<T>): Promise<T> {
  manager.itemStart(url)
  return work.finally(() => manager.itemEnd(url))
}

/** 0..1, and whether it has all arrived (nothing new started for a moment). */
export function loadingProgress(): { fraction: number; done: boolean } {
  const fraction = state.total ? state.loaded / state.total : 0
  const settled = performance.now() - state.lastChange > 700
  return { fraction, done: state.total > 0 && state.loaded >= state.total && settled }
}
