# Troubleshooting `@albatros/auth-shared`

Bugs rencontrés en production sur les apps consommatrices, leurs causes
racines, et les correctifs côté **app** (renderer) ou côté **package** (à
considérer pour une future version).

> Ce document n'est pas un guide d'intégration — pour l'intégration
> initiale, voir [INTEGRATION.md](INTEGRATION.md).

## Sommaire

| # | Sujet | Statut | Release |
|---|---|---|---|
| 1 | Auto-lock "malgré l'activité" | ✅ Cause définitive en **Bug #4** | v2.0.1 (defense) + per-app `auth:requestLock` |
| 2 | Crashes `X is not iterable` post-unlock | ✅ Résolu | **v2.0.0** (`throw NotUnlockedError`) |
| 3 | Race `verifyCode` → re-lock instantané | ✅ Résolu | per-app reorder + **v2.0.1** (deferred initial check) |
| 4 | Cascade : un tracker idle locke toutes les apps | ✅ Résolu | per-app `auth:requestLock` IPC |

---

## Bug #1 — Auto-lock se déclenche après ~10 minutes "malgré l'activité"

> **🔴 Cause racine définitive** : voir [Bug #4](#bug-4--cascade-lock--un-tracker-idle-locke-toutes-les-apps).
> Les hypothèses A/B/C ci-dessous étaient des pistes initiales partielles ou
> non-cause. La cause réelle est qu'**un tracker renderer idle dans une app
> propage le lock à toutes les autres** via `session.bin`, même quand
> l'utilisateur est actif dans l'une des sœurs.

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

### Améliorations livrées en v1.2.0 (collatérales, ne résolvent pas Bug #1)

- **Sleep-aware idle-watcher** (cf. Cause B) : `createIdleWatcher` détecte
  un drift `> pollMs * 3` entre deux ticks et bumpe `lastActivityAt` au
  lieu de locker immédiatement après wake. Réduit le faux-positif "lock
  juste après ouverture du laptop".
- **`useIdleLock` hissé dans `/react`** (cf. Cause C) : pattern `useRef`
  centralisé dans le package, plus de duplication ni de risque
  d'arrow-inline-callback côté apps.

### Résolution finale

Le symptôme initial mélangeait plusieurs phénomènes — la veille système
(Cause B) en a expliqué une partie après les premiers diagnostics, et
l'anti-pattern React (Cause C) ajoutait du bruit. Mais la **cause
dominante** s'est révélée être **Bug #4 (cascade)** : suffit qu'**une
seule** app Albatros ouverte sans activité locale fasse fire son tracker
renderer pour que `session.bin` passe en `locked` et que **toutes** les
apps Albatros bascule sur LockPage. Reproduit en isolant Prospector
seul (11 min sans lock) puis avec Cadence ouvert en background (lock
au bout de ~10 min).

---

## Bug #2 — Erreurs `"X is not iterable"` / `"X.filter is not a function"` après un unlock

> **✅ Résolu en v2.0.0** : `createGuardedHandle` lance désormais
> `NotUnlockedError` au lieu de retourner l'enveloppe `NOT_UNLOCKED_ERROR`.
> Helper `isNotUnlockedError(err)` exposé pour le check côté renderer.
> Voir [MIGRATION_v1_to_v2.md](MIGRATION_v1_to_v2.md).

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

### Décision livrée

**Option A retenue → v2.0.0** (commit `e2e5d80`, tag `v2.0.0`).
Audit cross-app validé : 0 occurrence de `result.success === false`
ni de lecture de `error.code` dans Prospector / Cadence / CM →
breaking change avec impact réel nul. Helper `isNotUnlockedError`
ajouté dans `/browser` pour standardiser le check côté renderer.

---

## Bug #3 — Race `verifyCode` → l'app se re-locke synchrone après unlock

### Symptôme rapporté

> *"Je viens d'ouvrir Recruiter, seul, pour la première fois, et de
> rentrer le code. L'application s'est ouverte, sans donnée, avec un
> message d'erreur : Impossible de charger les données."*

DevTools console montrait 8 erreurs identiques :

```
[sidebar] getSidebarCounts: Error: Error invoking remote method
'db:getSidebarCounts': NotUnlockedError: Application verrouillée,
déverrouillez-la pour continuer.

[vector] getStatus: Error: Error invoking remote method
'vector:getStatus': NotUnlockedError: ...

Error loading dashboard stats: Error: Error invoking remote method
'db:getDashboardStats': NotUnlockedError: ...

Error loading settings: Error: Error invoking remote method
'db:getAllSettings': NotUnlockedError: ...
```

L'utilisateur a **réussi à se déverrouiller** (il a vu son dashboard),
mais toutes les fetches IPC qui ont suivi ont rejeté avec
`NotUnlockedError` — alors que main est censé être déverrouillé.

### Diagnostic

Séquence du handler `auth:verifyCode` (avant le fix) :

```ts
ipcMain.handle('auth:verifyCode', async (_e, code: string) => {
  const ok = await authService.verifyCode(code)
  if (ok) {
    authState.setUnlocked(true)            // ← (1) déclenche onUnlockChange
    sessionService.recordUnlock({ ... })   // ← (4) trop tard
  }
  return { success: true, ok, ... }        // ← (5) renderer pense unlocked
})
```

Trace synchrone détaillée :

```
1. authState.setUnlocked(true)
   └─ déclenche tous les listeners onUnlockChange
   └─ un d'eux : "restart idle-watcher"
       └─ idleWatcher = ctx.startIdleWatcher(...)
       └─ idleWatcher.start()
           └─ check() immédiat (initial check)
               └─ state = sessionService.read()    ← (2) lit session.bin
               └─ state.isLocked === TRUE          ← session.bin pas encore mis à jour !
               └─ onLock() → authState.setUnlocked(FALSE)  ← (3) main re-lock !
2. sessionService.recordUnlock(...)  ← (4) session.bin mis à jour, mais main est déjà
                                        re-locké en mémoire
3. return { success: true, ok }      ← (5) renderer reçoit succès
4. Renderer flippe state à 'unlocked', monte AppContent
5. Composants fire fetches IPC → guardedHandle voit isUnlocked=false → NotUnlockedError partout
```

### Pourquoi visible dans CM mais pas Prospector au début

CM utilise `makeGuardedIpcMain` (Proxy sur `ipcMain`) qui wrappe **tous**
les handlers DB (40+) via `guardedHandle`. Donc tous les `ipcMain.handle('db:*')`
sont gated → toutes les fetches échouent bruyamment au render.

Prospector V2 a moins de surface gated et ses stores ont des
`try/catch` silencieux (sauf `contacts.ts` qu'on avait explicitement
durci au Bug #2). Bug latent mais peu visible.

### Correctif côté app (les 3 apps)

Dans `auth:setup`, `auth:verifyCode`, `auth:recover`, **inverser
l'ordre** : `recordUnlock(...)` AVANT `setUnlocked(true)`. Comme ça
quand le watcher restart fire son immediate check, `session.bin` est
déjà à jour.

```ts
// AVANT (race)
authState.setUnlocked(true)
sessionService.recordUnlock({ lockTimeoutMinutes: ... })

// APRÈS
sessionService.recordUnlock({ lockTimeoutMinutes: ... })
authState.setUnlocked(true)
```

Commits :

- Prospector V2 : [`826d3c2`](https://github.com/Albatros0626/PROSPECTOR/commit/826d3c2)
- Cadence : [`3d980b3`](https://github.com/Albatros0626/Cadence/commit/3d980b3)
- Candidate Manager : [`55e1f79`](https://github.com/Albatros0626/RECRUITER/commit/55e1f79)

### Correctif côté package — v2.0.1 (defense in depth)

Si un futur consommateur oublie l'ordre, on défend dans le package.
`createIdleWatcher.start()` défère son initial check via
`setTimeout(check, 0)` :

```ts
// src/idle-watcher.ts (v2.0.1)
start(): void {
  if (running) return
  running = true
  triggered = false
  lastTickAt = Date.now()

  // Polling + watch armés AVANT le check, pour ne pas se faire
  // auto-stop si l'initial check fire onLock.
  interval = setInterval(check, pollMs)
  unsubscribe = sessionService.watch(() => check())

  // Initial check déféré au prochain macrotask. Permet à un caller
  // qui flippe authState puis fait son recordUnlock synchrone de
  // finir avant qu'on ne lise session.bin.
  setTimeout(() => { if (running) check() }, 0)
}
```

Commit package : [`d26b3b4`](https://github.com/Albatros0626/albatros-auth-shared/commit/d26b3b4)
(tag `v2.0.1`).

### Tests

Test reproducteur ajouté dans `src/idle-watcher.test.ts` :

```ts
it('deferred initial check tolerates same-tick session.bin updates', async () => {
  const lockedState = makeLockedState()
  const validState = makeValidState()
  const session = makeStubSession(lockedState)
  const onLock = vi.fn()
  const w = createIdleWatcher({ sessionService: session, onLock, pollMs: 100 })

  w.start()
  // Same-tick : caller met session.bin à jour APRÈS start, comme un
  // unlock handler avec ordre setUnlocked → recordUnlock.
  session.setMockState(validState)

  await new Promise((r) => setTimeout(r, 0))

  expect(onLock).not.toHaveBeenCalled()
  expect(w.isRunning()).toBe(true)
})
```

---

## Bug #4 — Cascade : un tracker idle locke toutes les apps

### Symptôme rapporté

> *"Aujourd'hui j'ai utilisé les 3 apps et globalement j'ai remarqué
> que le verrouillage a lieu même lors d'une activité (observé à
> minima sur Prospector et Cadence)."*

Reproduction empirique : Prospector ouvert seul, utilisé activement
pendant 11min30 → **pas de lock**. Avec Cadence ouvert en background
sans interaction → **les 2 lockent au bout de ~10 min**.

### Diagnostic

Chaque app a son propre `useIdleLock` côté renderer qui crée un tracker
local basé sur les événements DOM **de sa propre fenêtre uniquement**.
Quand le tracker fire `onIdle` après `lockTimeoutMinutes` de silence
DOM local, il appelle `auth:lock` → main lock → `session.bin` marqué
verrouillé → propagation cross-app via `session.watch` → **toutes les
apps Albatros se lockent**, même si l'utilisateur est actif dans l'une
des autres.

```
t=0 : User actif dans Prospector. Cadence ouvert mais inactif.
      session.bin#lastActivityAt bumpé toutes les 10s par Prospector.
      Cadence renderer : 0 événement DOM sur sa fenêtre.

t=10min : Cadence renderer's tracker fire onIdle (10 min de silence
          local). Appelle window.api.auth.lock() → IPC auth:lock →
          main Cadence lock + sessionService.recordLock() →
          session.bin.lockedAt = t+10:00.

t=10min + Δ : Prospector main session.watch fire (debounced ~100ms)
              → state.isLocked === true → authState.setUnlocked(false)
              → renderer onAuthStateChanged → AppContent unmount →
              LockPage. Prospector LOCKÉ malgré l'activité.

t=10min + Δ : CM idem.
```

### Cause profonde

Le tracker renderer fire `onIdle` **sans consulter** `session.bin`.
Il ne sait pas qu'une autre app Albatros pousse de l'activité.
`session.bin#lastActivityAt` est pourtant à jour (bumpé par Prospector
toutes les 10s) — mais le tracker de Cadence ne lit pas ce fichier
côté renderer.

Le main-side idle-watcher **respecte** `session.bin` correctement
(c'est sa fonction). Mais le renderer-side tracker court en parallèle
avec sa propre logique purement locale.

### Correctif côté app (les 3 apps)

Nouveau IPC handler `auth:requestLock` qui consulte `session.bin`
avant de locker :

```ts
ipcMain.handle('auth:requestLock', () => {
  const state = sessionService.read()
  if (!state) {
    return { locked: false, reason: 'no-session' as const }
  }
  if (state.isLocked) {
    return { locked: true, reason: 'already-locked' as const }
  }
  if (!state.isExpired) {
    return { locked: false, reason: 'cross-app-active' as const }
  }
  // Toutes les apps idle depuis lockTimeoutMinutes — vraiment expiré.
  sessionService.recordLock()
  authState.setUnlocked(false)
  return { locked: true, reason: 'expired' as const }
})
```

Côté renderer, `useIdleLock` change son `onLock` :

```tsx
// AVANT
useIdleLock({
  timeoutMinutes,
  onLock: () => { void lock() },                      // ← appelle auth:lock direct
  onActivity: () => { void recordActivity() },
})

// APRÈS
useIdleLock({
  timeoutMinutes,
  onLock: () => { void window.api.auth.requestLock() }, // ← consulte session.bin
  onActivity: () => { void recordActivity() },
})
```

Quand `requestLock` retourne `{ locked: true, ... }`, main flippe
`authState` → `onAuthStateChanged` propage au renderer →
`AppContent` ou équivalent passe sur `LockPage`. Pas besoin
d'appeler `lock()` localement.

Le bouton "Lock now" / "Verrouiller" manuel continue d'utiliser
`auth:lock` direct (inconditionnel) — le user a explicitement demandé.

Commits :

- Prospector V2 : [`0570fed`](https://github.com/Albatros0626/PROSPECTOR/commit/0570fed)
- Candidate Manager : [`751e93d`](https://github.com/Albatros0626/RECRUITER/commit/751e93d)
- Cadence : [`360c424`](https://github.com/Albatros0626/Cadence/commit/360c424)

### Comportement après le fix

| Scénario | Avant | Après |
|---|---|---|
| 3 apps idle pendant 10 min | Toutes lockent ~10 min | Toutes lockent ~10 min ✓ (pas de régression) |
| Active dans Prospector, Cadence + CM idles en background | Toutes lockent à ~10 min ❌ | Aucune lock — Cadence/CM trackers fire mais sont refusés ✓ |
| Active dans Cadence + CM idles fermés | Aucune lock | Aucune lock ✓ |
| Lock manuel via bouton Settings | Lock immédiat | Lock immédiat ✓ |

### Comportement des trackers refusés

Quand `requestLock` retourne `{ locked: false, reason: 'cross-app-active' }`,
le tracker côté renderer reste **dormant** (le timer interne de
`createActivityTracker` est null après avoir fire onIdle). Le prochain
événement DOM local relance un compteur frais via `recordActivity()` →
le timer redémarre proprement.

Conséquence UX : si tu reviens sur une app qui a déjà fire son onIdle
refusé, le premier mouvement de souris/clic relance les 10 min depuis ce
moment-là. Pas de lock spurious tant que tu interagis.

### Pistes d'amélioration côté package (non implémentées)

- **Hisser `auth:requestLock` dans le package** : 3 apps ont la même
  implémentation, candidat à factorisation. Un futur `createRequestLockHandler({ sessionService, authState })`
  retournerait le handler prêt à brancher. v2.1.0 ?
- **Hisser le wiring renderer** : `useIdleLock` pourrait accepter un
  callback `onLockRequest` qui retourne le résultat structuré, ou
  carrément une option `consultSessionBeforeLocking: true` qui fait
  l'IPC en interne. À mûrir.

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

### Timeline des releases package

| Date | Release | Cible | Statut |
|---|---|---|---|
| 2026-05-02 | v1.1.4 | `sessionService.updateLockTimeoutMinutes` (live cross-app propagation) | ✅ |
| 2026-05-04 | **v1.2.0** | sleep-aware idle-watcher + `/react useIdleLock` + `isGuardedError` | ✅ |
| 2026-05-04 | **v2.0.0** | `createGuardedHandle` throws `NotUnlockedError` (BREAKING) → résout Bug #2 | ✅ |
| 2026-05-04 | **v2.0.1** | `idle-watcher` initial check déféré → defense pour Bug #3 | ✅ |

### Timeline des bugs

- **2026-05-04 (1ère phase)** — Document initial. Bugs #1 (auto-lock
  "malgré activité") et #2 (`NOT_UNLOCKED_ERROR` non-array) après
  l'adoption d'auth-shared par Prospector V2. Fixes appliqués côté
  app uniquement ; analyse incomplète sur Bug #1.

- **2026-05-04 (2ème phase)** — Releases v1.2.0 puis v2.0.0 livrées.
  Bug #2 résolu structurellement (throw au lieu de retour d'enveloppe).
  3 apps migrées en v2.0.0.

- **2026-05-05** — **Bug #3** identifié sur Candidate Manager après
  premier rebuild v2.0.0 : tous les handlers DB rejettent
  `NotUnlockedError` immédiatement après unlock. Diagnostic via
  DevTools : ordre `setUnlocked(true)` puis `recordUnlock(...)` dans
  les handlers d'auth crée une race où l'idle-watcher lit
  `session.bin` encore en `locked` et re-locke synchroneusement.
  Fix per-app (reorder) + release v2.0.1 (defense in depth).

- **2026-05-06** — **Bug #4** confirmé empiriquement. Test isolé
  (Prospector seul, 11min30 sans lock) confirme que la cause des
  symptômes "lock malgré activité" est la **cascade** : un tracker
  renderer idle dans une app sœur appelle `auth:lock` → `session.bin`
  → propagation. Fix per-app : nouveau IPC `auth:requestLock` qui
  consulte `session.bin` avant de locker, refuse si une autre app a
  poussé de l'activité dans la fenêtre `lockTimeoutMinutes`. Bug #1
  considéré comme résolu par ricochet.

### Inventaire des commits côté apps

| App | Phase 1 (Bug #1+#2 patches locaux) | Phase 2 (v1.2.0+v2.0.0) | Phase 3 (Bug #3 reorder) | Phase 4 (Bug #4 requestLock) |
|---|---|---|---|---|
| Prospector V2 | `63db20d` | `523d687` + `ea53525` | `826d3c2` | [`0570fed`](https://github.com/Albatros0626/PROSPECTOR/commit/0570fed) |
| Cadence | — | `40d14b6` + `74b477e` | `3d980b3` | [`360c424`](https://github.com/Albatros0626/Cadence/commit/360c424) |
| Candidate Manager | — | `214e9cd` + `31e8181` | `55e1f79` | [`751e93d`](https://github.com/Albatros0626/RECRUITER/commit/751e93d) |
