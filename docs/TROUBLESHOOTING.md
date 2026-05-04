# Troubleshooting `@albatros/auth-shared`

Bugs rencontrés en production sur les apps consommatrices, leurs causes
racines, et les correctifs côté **app** (renderer) ou côté **package** (à
considérer pour une future version).

> Ce document n'est pas un guide d'intégration — pour l'intégration
> initiale, voir [INTEGRATION.md](INTEGRATION.md).

---

## Bug #1 — Auto-lock se déclenche après ~10 minutes "malgré l'activité"

### Symptôme rapporté

> *"Le verrouillage de l'application a lieu systématiquement après 10 minutes,
> peu importe l'activité, et parfois au milieu d'une action que je suis en
> train de réaliser sur l'application."*

### Diagnostic

Inspection du fichier `session.bin` (`%LOCALAPPDATA%\AlbatrosApps\session.bin`)
au moment du blocage :

```json
{
  "version": 2,
  "unlockedAt":     "2026-05-04T05:12:52.304Z",
  "lastActivityAt": "2026-05-04T05:44:58.017Z",
  "lockTimeoutMinutes": 10,
  "lockedAt":       "2026-05-04T06:18:02.524Z",
  "unlockerAppId": "prospector"
}
```

Constat : `lastActivityAt` n'a plus été mis à jour pendant **33 minutes**
avant que le lock soit enregistré. La machine n'a vu (ou n'a pas remonté)
aucun événement d'activité dans cette fenêtre.

### Causes possibles (non mutuellement exclusives)

#### Cause A — Activité hors apps Albatros

L'idle-watcher du package se base **exclusivement** sur les événements DOM
captés par le renderer Electron de l'app :
`mousemove / mousedown / keydown / touchstart / wheel` sur `window`.

Si l'utilisateur travaille dans une autre application (navigateur, IDE,
Outlook...) sans toucher la fenêtre Electron, le renderer ne capte rien,
`session.bin#lastActivityAt` reste figé, l'idle-watcher détecte une expiration
au bout de `lockTimeoutMinutes` minutes. **C'est le comportement nominal
du package**, pas un bug — mais le ressenti utilisateur est qu'il a "été
actif".

> **Décision design** : ne **pas** capter d'activité système globale
> (hooks Windows `SetWindowsHookEx`, etc.) — trop intrusif, drapeaux AV,
> impossible sur macOS/Linux sans permissions. La granularité reste
> "activité dans une app Albatros".

#### Cause B — Sleep / hibernation / mise en veille

`createIdleWatcher` utilise `setInterval(check, pollMs)` et compare
`Date.now()` à `lastActivityAt`. Quand la machine sort de veille après une
longue suspension, le **prochain tick** détecte instantanément l'expiration
et lock l'app immédiatement. L'utilisateur a l'impression que "le lock est
arrivé tout de suite alors que je viens juste de revenir".

Dans l'incident observé : 33 min entre la dernière activité et le lock,
qui ressemble fortement à un cycle de veille (Windows par défaut : écran
éteint à 10 min, mise en veille à 30 min sur batterie).

#### Cause C — Anti-pattern React `useEffect` (résolu côté app)

L'app appelait `useIdleLock` avec des arrow functions inline :

```ts
useIdleLock({
  timeoutMinutes: ...,
  onLock:    () => { void lock() },                          // ← nouveau référent
  onActivity:() => { void window.electronAPI.authRecordActivity() }, // à chaque render
})
```

Si les deps de l'effet incluent `onLock` / `onActivity`, l'effet se
**détruit + recrée à chaque render** du parent. À chaque cycle :

- `tracker.stop()` + `tracker.start()` → le timer interne de
  `createActivityTracker` est **réinitialisé** ;
- les listeners DOM sont retirés puis ré-attachés.

Effet collatéral : si un render arrive juste avant que le timer expire,
celui-ci redémarre. Si à l'inverse le parent ne re-rend pas pendant
10 minutes (cas réel sur App.tsx au steady state), le timer expire
normalement même si l'utilisateur tape dans une autre app.

**Cet anti-pattern n'explique pas à lui seul le symptôme rapporté** (le
parent ne re-rend pas en steady state ici), mais il introduit une classe
de fragilités (perte d'événements, fuites de listeners) qu'il faut
éliminer dans toute intégration.

### Correctif côté app (Prospector V2 — appliqué)

`apps/desktop/src/renderer/hooks/useIdleLock.ts` : pattern `useRef` pour
stabiliser les callbacks et retirer les deps non-stables de l'effet.

```ts
import { useEffect, useRef } from 'react'
import { createActivityTracker } from '@albatros/auth-shared/browser'

export function useIdleLock({ timeoutMinutes, onLock, onActivity }: UseIdleLockOpts): void {
  // Refs : on capture les dernières callbacks sans rejouer l'effet.
  const onLockRef     = useRef(onLock)
  const onActivityRef = useRef(onActivity)
  useEffect(() => {
    onLockRef.current     = onLock
    onActivityRef.current = onActivity
  }, [onLock, onActivity])

  useEffect(() => {
    if (!timeoutMinutes || timeoutMinutes <= 0) return

    const tracker = createActivityTracker({
      timeoutMs: timeoutMinutes * 60_000,
      onIdle: () => onLockRef.current(),
    })
    tracker.start()

    let lastIpcCall = 0
    const handler = () => {
      tracker.recordActivity()
      const now = Date.now()
      if (now - lastIpcCall > 1_000) {
        lastIpcCall = now
        onActivityRef.current?.()
      }
    }
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, handler))

    return () => {
      tracker.stop()
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, handler))
    }
  }, [timeoutMinutes])  // ← seules les vraies deps "structurelles"
}
```

### Recommandation pour les autres apps

Dupliquer le pattern dans **Cadence** (`useIdleLock.ts`) et **Candidate
Manager** (`hooks/useIdleLock.tsx` / Context). L'arrow function inline
côté parent est un piège standard React qui touche toutes les
intégrations.

### Pistes d'amélioration côté package (non implémentées)

- **Hook resume après veille** : exposer un helper qui s'abonne à
  `powerMonitor.on('resume')` (Electron) et à
  `document.addEventListener('visibilitychange')` (browser) pour
  *forcer une grâce* de quelques secondes après wake — l'utilisateur a
  le temps de bouger la souris avant lock.
- **Timeline d'activité dans `session.bin`** : enregistrer aussi
  `lastResumeAt` pour distinguer "vraiment idle 10 min" de "veille
  système 30 min puis wake".

---

## Bug #2 — Erreurs `"X is not iterable"` / `"X.filter is not a function"` après un unlock

### Symptôme rapporté

> *"Lorsque je saisis le mot de passe après un blocage suite à une période
> d'inactivité, je rencontre des erreurs (voir captures d'écran)."*
>
> Erreurs affichées :
> - `P is not iterable`
> - `e.filter is not a function`

(`P` / `e` = noms de variables minifiés du bundle de prod.)

### Diagnostic

Cause racine **dans le package** : [`createGuardedHandle`](../src/guarded-handle.ts)
**retourne** un objet d'erreur quand l'app est verrouillée, au lieu de
**lever une exception**.

```ts
// src/guarded-handle.ts
export const NOT_UNLOCKED_ERROR: GuardedError = {
  success: false,
  error: { code: 'NOT_UNLOCKED', message: 'Application verrouillée, …' },
}

export function createGuardedHandle({ ipcMain, authState }) {
  return function guardedHandle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!authState.isUnlocked()) {
        return NOT_UNLOCKED_ERROR        // ← retour d'objet, pas throw
      }
      return listener(event, ...args)
    })
  }
}
```

Côté renderer, un store qui fait :

```ts
const contacts = await window.electronAPI.getContacts()
set({ contacts })   // contacts est { success: false, error: {…} }, pas un Array
```

…stocke l'objet d'erreur dans `state.contacts`. Le `try/catch` du store
n'attrape rien (la promesse n'est pas rejetée). Au prochain render, un
composant fait `state.contacts.filter(...)` ou `for (const c of state.contacts)`
→ **crash**.

### Fenêtre de course (race condition)

Le scénario type :

```
t=0     User idle. Vivier monté, contacts chargés.
t=10:00 idle-watcher ferme la session : authState.setUnlocked(false)
t=10:00 La page se démonte (App.tsx gate `if (!isUnlocked) return <LockPage/>`)
        — MAIS la promise `window.electronAPI.getContacts()` est déjà en vol.
t=10:00 + 50ms : la promise résout côté main → guardedHandle voit isUnlocked=false
        → retourne NOT_UNLOCKED_ERROR.
t=10:00 + 60ms : le store ne checke pas `Array.isArray`, set({ contacts: errorEnvelope }).
t=10:30 User saisit mdp → unlock → AppContent remonte → Vivier monte
        → useEffect lance fetchContacts → mais le rendu initial du composant
          se fait avec l'ancien state contaminé → `.filter()` crash.
```

### Correctif côté app (Prospector V2 — appliqué)

`apps/desktop/src/renderer/stores/contacts.ts` : garde `Array.isArray`
avant de stocker.

```ts
fetchContacts: async (stage) => {
  // …
  const results = await window.electronAPI.searchContacts(searchQuery)
  if (fetchId !== _contactsFetchId) return
  if (!Array.isArray(results)) {
    console.error('[Store] searchContacts returned non-array:', results)
    set({ contacts: [], isLoading: false, currentStage: stage || 'all' })
    return
  }
  // …
}
```

C'est un **patch défensif local**. Tous les autres stores qui font
`await electronAPI.X()` puis `set({ data: result })` sont vulnérables
au même problème — il faudra les durcir un par un, ou (mieux) régler
ça dans le package (voir ci-dessous).

### Stores connus restant à durcir (Prospector V2)

Inventaire à compléter au fil des incidents — chaque store qui passe
par un IPC `guardedHandle()` est candidat :

- `companies.ts`
- `entreprises.ts`
- `reminder.ts`
- `todo.ts`
- `vectorization.ts`
- `campaigns.ts`
- `enrichment.ts`
- `lusha.ts`
- `settings.ts`
- `search.ts`

Pour chacun : avant chaque `set({ X: result })`, vérifier la forme du
résultat (`Array.isArray`, ou `typeof result === 'object' && !('error' in result)`).

### Recommandations côté package (à considérer pour la prochaine version)

#### Option A — `guardedHandle` lance une exception au lieu de retourner

```ts
export class NotUnlockedError extends Error {
  code = 'NOT_UNLOCKED' as const
  constructor(message = 'Application verrouillée, déverrouillez-la pour continuer.') {
    super(message)
    this.name = 'NotUnlockedError'
  }
}

export function createGuardedHandle({ ipcMain, authState }) {
  return function guardedHandle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!authState.isUnlocked()) {
        throw new NotUnlockedError()    // ← throw plutôt que return
      }
      return listener(event, ...args)
    })
  }
}
```

**Avantages** :
- Côté renderer, `await ipcRenderer.invoke(...)` lève une `Error`
  serializée par Electron — le `try/catch` des stores l'attrape
  normalement → pas besoin de `Array.isArray` partout.
- Sémantique alignée avec le reste de l'écosystème JS (`fetch` qui
  rejette sur erreur réseau, etc.).

**Inconvénients** :
- **Breaking change** : tous les call-sites consommateurs qui
  s'appuyaient sur `.success === false` en réception cassent. Il
  faut un **audit cross-app** avant publication. À ce jour, aucun
  consommateur connu ne lit `success`/`error` côté renderer (les
  erreurs étaient en pratique silencieuses jusqu'à ce bug) — donc
  l'impact réel est probablement faible, mais à vérifier.
- Versionner en `v2.0.0` (semver major).

#### Option B — Helper d'unwrap exposé côté browser

Ajouter un utilitaire dans `@albatros/auth-shared/browser` que les
stores wrappent autour de leurs invokes :

```ts
import { unwrapGuarded } from '@albatros/auth-shared/browser'

const contacts = await unwrapGuarded(window.electronAPI.getContacts())
//   ↑ throws NotUnlockedError si guarded retourne l'envelope d'erreur
//   ↑ retourne le payload sinon
```

**Avantages** :
- Pas de breaking change pour les apps qui n'adoptent pas.
- Migration incrémentale, store par store.

**Inconvénients** :
- Faut wrapper chaque appel manuellement → friction.
- Deux modes coexistent (avec/sans wrapper) → l'incohérence est un
  futur foot-gun.

### Recommandation

**Option A en `v2.0.0`**, avec un audit cross-app rapide pour confirmer
que personne ne lit `result.success === false`. La sémantique "throw
sur erreur" est ce qu'attendent naturellement les consommateurs, et
épargne le durcissement défensif dans chaque store de chaque app.

---

## Convention de mise à jour de ce document

À chaque incident reproductible documenté :

1. Ajouter une section `## Bug #N — <résumé en 1 ligne>`.
2. Garder l'ordre : **Symptôme** (citation utilisateur si possible) →
   **Diagnostic** (données brutes, stack traces) → **Cause** → **Correctif
   appliqué** (côté app) → **Recommandations package** (à arbitrer pour
   une release majeure / mineure / patch).
3. Référencer les commits/PR qui appliquent les fixes côté app.

---

## Historique

- **2026-05-04** — Document initial. Bugs #1 (auto-lock) et #2
  (`NOT_UNLOCKED_ERROR` non-array) après l'adoption d'auth-shared par
  Prospector V2. Fixes appliqués côté app uniquement ; aucune release
  package effectuée.
