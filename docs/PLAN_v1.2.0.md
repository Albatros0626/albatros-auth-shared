# Plan v1.2.0 — non-breaking robustness pass

**Cible release** : `@albatros/auth-shared` v1.2.0
**Type** : minor (semver) — aucune cassure d'API, aucune modif requise côté apps consommatrices.

**Origine** : retours de production après l'adoption par Prospector V2 (cf.
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) Bug #1 et #2).

---

## Objectifs

1. **Réduire le faux-positif "auto-lock après wake"** sans changer la sémantique nominale.
2. **Centraliser le hook `useIdleLock`** (aujourd'hui dupliqué 3 fois entre Prospector / Cadence / CM) pour éliminer la divergence et verrouiller le bon pattern React.
3. **Outiller les apps qui n'ont pas migré vers v2.0.0** avec un type-guard `isGuardedError(x)` pour durcir leurs stores sans réécrire la logique.
4. **Documenter** les pièges d'intégration (callbacks inline) dans INTEGRATION.md.

**Hors scope** : tout ce qui concerne la cause racine du Bug #2 (`guardedHandle` qui retourne au lieu de lever) — c'est traité dans [PLAN_v2.0.0.md](PLAN_v2.0.0.md).

---

## 1. `idle-watcher` sleep-aware

### Fichier : `src/idle-watcher.ts`

### Problème

`createIdleWatcher` utilise `setInterval(check, pollMs)`. Quand la machine sort de veille après une longue suspension :

- Le prochain tick fire (potentiellement bien après le délai prévu).
- `Date.now() - lastActivityAt > timeoutMs` → expiré → `onLock` appelé instantanément.

L'utilisateur a l'impression que "le lock arrive juste après mon retour" alors qu'il a juste rouvert son laptop.

### Solution

Détecter l'écart anormal entre deux ticks. Si `now - lastTickAt > pollMs * SLEEP_DETECTION_MULTIPLIER` (par défaut `* 3` → 15s), on considère que la machine vient de sortir de veille. Dans ce cas, on **bump `lastActivityAt`** dans `session.bin` pour offrir une fenêtre de grâce à l'utilisateur (équivalente à `lockTimeoutMinutes`) au lieu de lock immédiatement.

> **Décision design** : on n'écrase pas la sémantique sécurité (lock après inactivité réelle), on évite simplement de pénaliser un cycle de veille comme s'il était une inactivité utilisateur. Si l'utilisateur ne bouge pas après le wake, le lock survient au délai normal.

### Changements

```ts
// src/idle-watcher.ts

export const DEFAULT_SLEEP_DETECTION_MULTIPLIER = 3

export interface CreateIdleWatcherOpts {
  sessionService: SessionService
  onLock: () => void
  pollMs?: number
  /**
   * Multiplier on `pollMs` above which a tick is considered to come after a
   * system sleep. When that happens, `lastActivityAt` is bumped to grant a
   * fresh idle window instead of locking immediately. Default: 3.
   * Set to `Infinity` to disable sleep detection (legacy behavior).
   */
  sleepDetectionMultiplier?: number
}

export function createIdleWatcher(opts: CreateIdleWatcherOpts): IdleWatcher {
  const { sessionService, onLock, pollMs = DEFAULT_IDLE_POLL_MS,
          sleepDetectionMultiplier = DEFAULT_SLEEP_DETECTION_MULTIPLIER } = opts

  let lastTickAt = 0
  // …existing state…

  function check(): void {
    if (!running || triggered) return
    const now = Date.now()
    const drift = lastTickAt > 0 ? now - lastTickAt - pollMs : 0
    lastTickAt = now

    if (drift > pollMs * sleepDetectionMultiplier) {
      // System slept. Grant a fresh idle window.
      sessionService.recordActivity()
      return
    }

    const state = sessionService.read()
    // …existing expiration logic…
  }

  return {
    start(): void {
      // …
      lastTickAt = Date.now()
      // …
    },
    // …
  }
}
```

### Tâches

- [ ] **T1.1** Ajouter `sleepDetectionMultiplier` à `CreateIdleWatcherOpts` + constante `DEFAULT_SLEEP_DETECTION_MULTIPLIER = 3`.
- [ ] **T1.2** Implémenter le tracking `lastTickAt` dans `check()` et la branche "drift > seuil → recordActivity → return".
- [ ] **T1.3** Initialiser `lastTickAt` dans `start()`.
- [ ] **T1.4** Tests dans `idle-watcher.test.ts` :
  - [ ] sleep détecté → pas de lock immédiat
  - [ ] sleep détecté → `recordActivity` est appelé
  - [ ] après le sleep + nouveau délai d'inactivité → lock survient normalement
  - [ ] `sleepDetectionMultiplier: Infinity` → comportement legacy (lock instantané au wake)
- [ ] **T1.5** Vérifier que `idle-watcher.test.ts` existant passe toujours (utiliser `vi.useFakeTimers` si pas déjà fait).

### Notes

- L'option `sessionService.recordActivity()` réutilise le throttle existant (10s). C'est suffisant pour bumper `lastActivityAt` sans flooder.
- Pas besoin de hook `powerMonitor` Electron : la détection par drift marche partout (renderer/main/test) sans dépendance.

---

## 2. Hisser `useIdleLock` dans le package

### Fichiers : `src/browser.ts` (nouveau), nouveau subpath `/react`

### Problème

Le hook est dupliqué dans :

- `01 PROSPECTOR V2/apps/desktop/src/renderer/hooks/useIdleLock.ts` (corrigé v1, useRef pattern OK)
- `08 CADENCE/src/renderer/hooks/useIdleLock.ts` (Zustand selector → OK par chance)
- `03 CANDIDATE MANAGER/candidate-manager/src/hooks/useIdleLock.ts` (Context — à vérifier)

→ trois implémentations divergentes, pattern `useRef` non garanti partout.

### Solution

#### 2a. Helper non-React `attachActivityTracking` côté `/browser`

```ts
// src/browser.ts (export ajouté)
export interface AttachActivityTrackingOpts {
  /** Window where DOM events are listened for. Pass `window`. */
  target: Window
  timeoutMs: number
  onIdle: () => void
  onActivity?: () => void
  events?: ReadonlyArray<keyof WindowEventMap>
  /** IPC throttle for `onActivity` (default 1000ms). */
  throttleMs?: number
}

export const DEFAULT_ACTIVITY_EVENTS: ReadonlyArray<keyof WindowEventMap> =
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel']

/**
 * Bundles `createActivityTracker` + window listener wiring + IPC throttle.
 * Returns a `dispose` function — call it in your effect cleanup.
 */
export function attachActivityTracking(opts: AttachActivityTrackingOpts): () => void
```

#### 2b. Hook React `useIdleLock` côté `/react` (nouveau subpath)

```ts
// src/react.ts
import { useEffect, useRef } from 'react'
import { attachActivityTracking } from './browser'

export interface UseIdleLockOpts {
  /** 0 or negative → hook disabled. */
  timeoutMinutes: number
  onLock: () => void
  onActivity?: () => void
}

export function useIdleLock(opts: UseIdleLockOpts): void {
  const { timeoutMinutes, onLock, onActivity } = opts
  const onLockRef = useRef(onLock)
  const onActivityRef = useRef(onActivity)
  useEffect(() => {
    onLockRef.current = onLock
    onActivityRef.current = onActivity
  }, [onLock, onActivity])

  useEffect(() => {
    if (!timeoutMinutes || timeoutMinutes <= 0) return
    return attachActivityTracking({
      target: window,
      timeoutMs: timeoutMinutes * 60_000,
      onIdle: () => onLockRef.current(),
      onActivity: () => onActivityRef.current?.(),
    })
  }, [timeoutMinutes])
}
```

#### 2c. `package.json` — ajouter le subpath et la peer-dep React optionnelle

```json
{
  "exports": {
    ".":        { "types": "./dist/index.d.ts",   "default": "./dist/index.js" },
    "./browser":{ "types": "./dist/browser.d.ts", "default": "./dist/browser.js" },
    "./react":  { "types": "./dist/react.d.ts",   "default": "./dist/react.js" }
  },
  "peerDependencies": {
    "electron": ">=28.0.0",
    "react":    ">=18.0.0"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  }
}
```

> React optional : seules les apps qui importent `/react` doivent avoir React installé (ce qui est le cas pour Prospector / Cadence / CM).

### Tâches

- [ ] **T2.1** Créer `src/browser.ts` avec `attachActivityTracking` + `DEFAULT_ACTIVITY_EVENTS` exportés.
- [ ] **T2.2** Créer `src/react.ts` avec `useIdleLock` (pattern useRef).
- [ ] **T2.3** `package.json` : ajouter export `/react`, peer-dep React optionnelle, devDep `react` + `@types/react` + `@testing-library/react` pour les tests.
- [ ] **T2.4** `tsconfig.json` : ajouter `react` aux `lib` + `jsx: "react-jsx"` (ou créer un tsconfig spécifique au subpath).
- [ ] **T2.5** Tests `src/browser.test.ts` : 5 cas pour `attachActivityTracking` (start, throttle, dispose, onIdle, onActivity sans onActivity).
- [ ] **T2.6** Tests `src/react.test.ts` : 4 cas pour `useIdleLock` (effect setup, ref stability, dispose, timeoutMinutes change).
- [ ] **T2.7** Mettre à jour Prospector pour utiliser `import { useIdleLock } from '@albatros/auth-shared/react'` (au lieu de l'impl locale). Garder le hook local en wrapper minimal s'il a besoin de logique app-specific.
- [ ] **T2.8** Idem Cadence et CM.

### Notes

- `attachActivityTracking` est testable sans React (Vitest + jsdom suffit). C'est le building block.
- `useIdleLock` ne fait que la plomberie React (refs + effect deps).

---

## 3. Type-guard `isGuardedError` pour les apps non-migrées

### Fichier : `src/browser.ts`

### Problème

Tant que la v2.0.0 (throw) n'est pas livrée, les apps doivent durcir leurs stores avec `Array.isArray` (ou équivalent) pour ne pas crasher sur `NOT_UNLOCKED_ERROR`. Le check est verbeux et facile à oublier.

### Solution

```ts
// src/browser.ts
import type { GuardedError } from './guarded-handle'
export type { GuardedError } from './guarded-handle'

export function isGuardedError(x: unknown): x is GuardedError {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o.success !== false) return false
  const err = o.error
  if (typeof err !== 'object' || err === null) return false
  return (err as Record<string, unknown>).code === 'NOT_UNLOCKED'
}
```

Usage côté store :

```ts
const result = await window.electronAPI.searchContacts(q)
if (isGuardedError(result)) {
  set({ contacts: [], isLoading: false })
  return
}
set({ contacts: result, isLoading: false })
```

### Tâches

- [ ] **T3.1** Re-exporter `GuardedError` depuis `/browser` (déplacer la définition de type vers un fichier neutre `src/guarded-handle-types.ts` partagé entre node et browser, ou la dupliquer si trivial).
- [ ] **T3.2** Implémenter `isGuardedError` dans `src/browser.ts`.
- [ ] **T3.3** Tests : 5 cas (objet valide, success: true, error.code différent, null, primitives).

---

## 4. Documenter les pièges dans INTEGRATION.md

### Fichier : `docs/INTEGRATION.md`

### Tâches

- [ ] **T4.1** Ajouter une section "**Auto-lock — pièges courants**" dans la partie renderer du guide.
  - ❌ callbacks inline dans `useIdleLock({ onLock: () => ... })` → effet recréé à chaque render
  - ✅ extraire en `useCallback` OU laisser le hook v1.2.0+ gérer les refs en interne (recommandé : utiliser `@albatros/auth-shared/react`)
- [ ] **T4.2** Ajouter une section "**Erreur `NOT_UNLOCKED` — durcir les stores**" qui pointe vers `isGuardedError` (et la migration future vers v2.0.0 qui rendra ça inutile).
- [ ] **T4.3** Mettre à jour les exemples de la TL;DR pour utiliser `@albatros/auth-shared/react` au lieu d'une impl locale.

---

## 5. Release & rollout

### Tâches

- [ ] **T5.1** `CHANGELOG.md` : section `## [1.2.0]` avec Added / Changed / Fixed.
- [ ] **T5.2** `package.json` : bump version à `1.2.0`.
- [ ] **T5.3** Build + test full suite (`npm run prerelease`).
- [ ] **T5.4** Tag git `v1.2.0` + push.
- [ ] **T5.5** Mettre à jour les `package.json` des 3 apps consommatrices :
  ```json
  "@albatros/auth-shared": "github:Albatros0626/albatros-auth-shared#v1.2.0"
  ```
- [ ] **T5.6** Pour chaque app : `pnpm install` + supprimer le `useIdleLock` local + smoke test (un cycle de lock/unlock + un cycle de sleep/wake).

### Critères d'acceptation

- [ ] Tous les tests existants passent.
- [ ] Les 4 nouvelles fonctions/hooks sont couvertes (≥ 90% line coverage).
- [ ] Smoke test manuel sur Prospector :
  - Lock après 10 min d'inactivité réelle ✓
  - Pas de lock immédiat après resume de veille ✓
  - Lock survient si l'utilisateur reste inactif `lockTimeoutMinutes` après le wake ✓
- [ ] Aucune régression cross-app (un unlock/lock dans une app propage aux autres).

---

## Estimation

| Section | Effort |
|---|---|
| 1. Sleep-aware idle-watcher | 1.5h (impl + 4 tests) |
| 2. Hisser useIdleLock | 3h (impl + tests + 3 apps à migrer) |
| 3. isGuardedError | 30min |
| 4. Documentation | 30min |
| 5. Release | 30min |
| **Total** | **~6h** |
