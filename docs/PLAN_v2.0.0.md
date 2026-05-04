# Plan v2.0.0 — `guardedHandle` jette plutôt que retourne

**Cible release** : `@albatros/auth-shared` v2.0.0
**Type** : major (semver) — **breaking change** sur la sémantique de `createGuardedHandle`.

**Origine** : cause racine du Bug #2 (cf. [TROUBLESHOOTING.md](TROUBLESHOOTING.md)) — le retour d'un objet d'erreur au lieu d'une exception fait que les `try/catch` côté renderer ne fonctionnent pas, et chaque store doit être durci individuellement.

**Pré-requis** : v1.2.0 livrée et adoptée par les 3 apps. La v1.2.0 introduit `isGuardedError` pour faciliter la transition.

---

## Objectif

Aligner la sémantique de `guardedHandle` sur l'écosystème JS standard : **erreur = exception**, pas valeur de retour. Ce qui rend automatiquement les stores qui font `await ipcInvoke()` puis `set({ data: result })` corrects sans modification, à condition qu'ils aient un `try/catch`.

---

## 0. Audit cross-app (PRÉ-REQUIS, à faire avant tout dev)

### Pourquoi

Avant de casser le shape de retour, il faut vérifier qu'**aucun consommateur** ne lit `result.success === false` ni `result.error.code`. Si quelqu'un le fait, son code casse silencieusement (le throw devient une promesse rejetée, donc le code après `await` ne s'exécute plus → pas un crash, juste un comportement différent).

### Tâches

- [ ] **T0.1** `grep` cross-app (Prospector / Cadence / CM) pour chacun des patterns suivants :
  - `\.success\s*===\s*false`
  - `\.error\?\.code\s*===\s*['"]NOT_UNLOCKED`
  - `NOT_UNLOCKED_ERROR` (import direct)
  - `isGuardedError` (introduit en v1.2.0 — chaque call-site devra être adapté)
- [ ] **T0.2** Pour chaque match : noter le call-site dans un tableau, indiquer si la nouvelle sémantique (exception) le casse ou non.
- [ ] **T0.3** Si la liste est vide ou triviale (≤ 5 sites tous adaptables), feu vert pour la v2.
- [ ] **T0.4** Sinon : décision à prendre (rester en v1.x avec helper, OU faire la v2 + un commit de migration par app).

### Hypothèse de travail

À ce stade (mai 2026), aucune app ne lit le shape — elles font toutes `await invoke()` puis stockent le résultat directement. Les ~30 sites `isGuardedError` introduits par la v1.2.0 deviendront obsolètes (à supprimer) après l'adoption v2.

---

## 1. Modifier `createGuardedHandle`

### Fichier : `src/guarded-handle.ts`

### Changements

```ts
// AVANT (v1.x)
export const NOT_UNLOCKED_ERROR: GuardedError = {
  success: false,
  error: { code: 'NOT_UNLOCKED', message: '…' },
}

export function createGuardedHandle({ ipcMain, authState }) {
  return function guardedHandle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!authState.isUnlocked()) return NOT_UNLOCKED_ERROR
      return listener(event, ...args)
    })
  }
}

// APRÈS (v2.0)
export class NotUnlockedError extends Error {
  readonly code = 'NOT_UNLOCKED' as const
  constructor(message = 'Application verrouillée, déverrouillez-la pour continuer.') {
    super(message)
    this.name = 'NotUnlockedError'
  }
}

export function createGuardedHandle({ ipcMain, authState }) {
  return function guardedHandle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!authState.isUnlocked()) {
        throw new NotUnlockedError()
      }
      return listener(event, ...args)
    })
  }
}
```

### Comportement côté renderer

Quand le main `throw`, Electron sérialise l'exception dans la promesse renvoyée par `ipcRenderer.invoke()`. Côté renderer, `await invoke(...)` rejette avec une `Error` dont le `name` et le `message` sont préservés. Le `code` custom est **perdu** (Electron ne sérialise que `name` + `message` + `stack`).

Pour qu'un consommateur puisse détecter "lock survenu pendant l'appel", trois options :

#### Option A — Préfixer le message (le plus simple)

```ts
throw new NotUnlockedError()
// → côté renderer : err.message commence par "Application verrouillée…"
//   ou err.name === 'NotUnlockedError'
```

`err.name` est préservé par Electron. Côté renderer :

```ts
try {
  const result = await window.electronAPI.getContacts()
} catch (err) {
  if (err instanceof Error && err.name === 'NotUnlockedError') {
    // app locked mid-call, ignore silently
    return
  }
  throw err
}
```

Helper côté `/browser` pour standardiser :

```ts
// src/browser.ts (v2)
export function isNotUnlockedError(err: unknown): boolean {
  return err instanceof Error && err.name === 'NotUnlockedError'
}
```

#### Option B — Sérialiser explicitement dans `ipcMain.handle`

Plus invasif, ne mérite pas le coût.

#### Option C — Renvoyer un IPC `Error` enrichi

Demande des hooks Electron spécifiques. Trop fragile.

→ **Choix : Option A**.

### Tâches

- [ ] **T1.1** Remplacer le retour de `NOT_UNLOCKED_ERROR` par `throw new NotUnlockedError()` dans `createGuardedHandle`.
- [ ] **T1.2** Définir la classe `NotUnlockedError` (étend `Error`, `name = 'NotUnlockedError'`, `code = 'NOT_UNLOCKED'`).
- [ ] **T1.3** Garder `NOT_UNLOCKED_ERROR` exporté pour rétro-compat de l'import (le constant n'est plus utilisé en interne, mais des consommateurs pourraient l'avoir importé). Marquer `@deprecated` dans le JSDoc.
- [ ] **T1.4** Garder `GuardedError` interface exportée pour les apps qui veulent typer "ce qu'aurait été" l'erreur. Marquer `@deprecated`.
- [ ] **T1.5** Ajouter `isNotUnlockedError(err: unknown): boolean` dans `src/browser.ts`.
- [ ] **T1.6** Ajouter `NotUnlockedError` aux exports de `src/index.ts` (main).

### Notes

- Le `throw` survient dans le `async (event, ...args) => { … }` passé à `ipcMain.handle`. Electron capture les exceptions de ce handler et les transforme en rejet de la promesse côté renderer. Comportement testé et documenté.
- Si quelqu'un a un autre `try/catch` qui appelle `guardedHandle` puis lit le retour, son code casse — c'est attendu (et l'objet de l'audit T0).

---

## 2. Adapter les tests

### Fichier : `src/guarded-handle.test.ts`

### Changements

| Test existant | Action v2 |
|---|---|
| `returns NOT_UNLOCKED_ERROR when locked` | Renommer + asserter `await expect(...).rejects.toThrow(NotUnlockedError)` |
| `NOT_UNLOCKED_ERROR has the right shape` | Conserver tel quel (le constant existe toujours pour rétro-compat) + ajouter un test `NotUnlockedError instance` |
| `lock between handler registration and invocation rejects the call` | Adapter à `rejects.toThrow` |
| `multiple guarded channels share the same auth state` | Adapter les deux assertions `equals(NOT_UNLOCKED_ERROR)` → `rejects.toThrow` |
| `forwards to inner listener when unlocked` | Conservé |
| `async listener result is awaited and returned` | Conservé |
| `listener throw propagates to caller` | Conservé |

### Tâches

- [ ] **T2.1** Mettre à jour `guarded-handle.test.ts` (~5 cas à adapter).
- [ ] **T2.2** Ajouter un test pour `isNotUnlockedError` dans `browser.test.ts` (3 cas : NotUnlockedError, autre Error, primitive).

---

## 3. Documentation

### Tâches

- [ ] **T3.1** `CHANGELOG.md` : section `## [2.0.0]` détaillée (Added, Changed, **BREAKING**, Migration).
- [ ] **T3.2** `README.md` : mettre à jour la section "Côté main — guardedHandle" pour montrer le `try/catch` côté renderer.
- [ ] **T3.3** `docs/INTEGRATION.md` : retirer la mention de `isGuardedError` (introduite en v1.2.0) — devenue inutile en v2. Remplacer par le nouveau pattern `try/catch` + `isNotUnlockedError`.
- [ ] **T3.4** `docs/MIGRATION_v1_to_v2.md` (nouveau) : guide pas-à-pas pour les apps qui adoptent v2.

### Contenu type de MIGRATION_v1_to_v2.md

```md
# Migrating from v1.x to v2.0.0

## Breaking change

`createGuardedHandle` now **throws** `NotUnlockedError` instead of returning
`NOT_UNLOCKED_ERROR` when the app is locked.

## Action required

### Côté main
Aucune action — le code qui utilise `guardedHandle` (l'enveloppe IPC) ne change pas.

### Côté renderer

#### Avant (v1.x)
```ts
const result = await window.electronAPI.getContacts()
if (!Array.isArray(result)) {
  // result is { success: false, error: { code: 'NOT_UNLOCKED', … } }
  return
}
```

#### Après (v2.0)
```ts
import { isNotUnlockedError } from '@albatros/auth-shared/browser'

try {
  const result = await window.electronAPI.getContacts()
  // result is the actual array, no shape check needed
} catch (err) {
  if (isNotUnlockedError(err)) {
    // app got locked mid-call, ignore silently
    return
  }
  throw err
}
```

#### Si vous aviez utilisé `isGuardedError` (v1.2.0)
Supprimez les call-sites — ils sont devenus inutiles. Les promesses rejettent
naturellement maintenant.
```

---

## 4. Adapter les apps consommatrices

Cette section est dans le plan parce que la v2.0 n'a de sens que si les apps en bénéficient. Idéalement on traite les 3 apps dans la même fenêtre de release pour éviter une période où certaines sont en v1, d'autres en v2.

### Pour chaque app (Prospector / Cadence / CM)

- [ ] **T4.1** `package.json` : passer `@albatros/auth-shared` à `#v2.0.0`.
- [ ] **T4.2** `pnpm install`.
- [ ] **T4.3** `grep` les call-sites `Array.isArray` introduits par la v1.2.0 → les supprimer (et restaurer le code original sans le check).
- [ ] **T4.4** `grep` les call-sites `isGuardedError` (v1.2.0) → remplacer par `try/catch + isNotUnlockedError`.
- [ ] **T4.5** Vérifier que **chaque store qui fait un IPC guarded** a un `try/catch` autour de son `await`. Si non, en ajouter un (silencieux pour `NotUnlockedError`, propage les autres).
- [ ] **T4.6** Smoke test : lock pendant qu'une fetch est en vol, vérifier que la console ne loggue pas d'erreur "P is not iterable" + que l'app revient en état propre après unlock.
- [ ] **T4.7** Build + tests app + commit.

### Stores Prospector concernés (recensés en v1.2.0)

`contacts.ts`, `companies.ts`, `entreprises.ts`, `reminder.ts`, `todo.ts`,
`vectorization.ts`, `campaigns.ts`, `enrichment.ts`, `lusha.ts`,
`settings.ts`, `search.ts`.

(Cadence et CM : à recenser au moment du dev — probablement moins, leur surface IPC étant plus petite.)

---

## 5. Release & rollout

### Tâches

- [ ] **T5.1** `package.json` : bump à `2.0.0`.
- [ ] **T5.2** Build + tests full (`npm run prerelease`).
- [ ] **T5.3** Tag `v2.0.0` + push.
- [ ] **T5.4** Adapter les 3 apps consommatrices (section 4) sur des branches dédiées.
- [ ] **T5.5** Merge des 3 apps en lockstep (idéalement dans la même journée pour minimiser la fenêtre v1/v2 mixte).

### Critères d'acceptation

- [ ] Tous les tests du package passent (suite mise à jour).
- [ ] Les 3 apps :
  - démarrent normalement
  - le lock pendant une fetch en vol n'affiche plus d'erreur côté console
  - le `try/catch` autour des IPC guarded est présent partout où ça compte
  - aucun `Array.isArray(result)` issu du fix temporaire v1.x ne subsiste

---

## Risques & mitigations

| Risque | Mitigation |
|---|---|
| Audit T0 révèle un consommateur qui dépendait du shape | Ajouter un commit avant la v2 qui le migre vers `try/catch + isGuardedError` (helper v1.2.0), puis adapter en v2 |
| Electron change le format de sérialisation entre versions | Pinner les versions Electron dans le `peerDependencies`, tester sur Electron 28 minimum |
| Un store sans `try/catch` casse en v2 (rejection non catchée) | T4.5 audite explicitement chaque store ; en cas d'oubli, l'erreur remonte au `unhandledrejection` qui est moins discret qu'un objet `{success: false}` silencieusement stocké → mieux vaut bruyant |
| Régression cross-app pendant la fenêtre v1/v2 mixte | Faire les 3 PR en parallèle, merger sur 1 jour |

---

## Estimation

| Section | Effort |
|---|---|
| 0. Audit cross-app | 30min |
| 1. Modif `guardedHandle` + `NotUnlockedError` | 1h |
| 2. Tests adaptés | 1h |
| 3. Documentation + migration guide | 1h |
| 4. Adapter 3 apps (≈ 1h chacune) | 3h |
| 5. Release coordonnée | 30min |
| **Total** | **~7h** |

---

## Décision finale

**Aller en v2** ssi **T0** passe (audit cross-app vert). Sinon, rester en v1.x avec `isGuardedError` indéfiniment.
