# Migrating from v1.x to v2.0.0

## Breaking change

`createGuardedHandle` now **throws** `NotUnlockedError` instead of *returning*
the `NOT_UNLOCKED_ERROR` envelope when an IPC call hits a locked app.

## Côté main — aucune action requise

Le code qui utilise `guardedHandle` pour déclarer ses handlers ne change
pas :

```ts
const guardedHandle = createGuardedHandle({ ipcMain, authState })

// Inchangé entre v1.x et v2.0.0
guardedHandle('contacts:getAll', async () => db.contacts.findMany())
```

Le `throw` se passe à l'intérieur du wrapper, transparent pour le listener
métier.

## Côté renderer — adapter chaque store qui passe par un handler guarded

### Avant (v1.x)

```ts
// Option A — durcissement avec Array.isArray
const result = await window.electronAPI.getContacts()
if (!Array.isArray(result)) {
  set({ contacts: [] })
  return
}
set({ contacts: result })

// Option B — durcissement avec isGuardedError (introduit en v1.2.0)
import { isGuardedError } from '@albatros/auth-shared/browser'
const result = await window.electronAPI.getContacts()
if (isGuardedError(result)) {
  set({ contacts: [] })
  return
}
set({ contacts: result })
```

### Après (v2.0.0)

```ts
import { isNotUnlockedError } from '@albatros/auth-shared/browser'

try {
  const result = await window.electronAPI.getContacts()
  // result est garanti d'être le vrai payload — aucun shape check.
  set({ contacts: result })
} catch (err) {
  if (isNotUnlockedError(err)) {
    // L'app s'est verrouillée pendant l'appel — ignore en silence ;
    // la prochaine fetch (post-unlock) repeuplera.
    set({ contacts: [] })
    return
  }
  throw err  // ou logger / toast pour les autres erreurs
}
```

### Avantages

- Le `try/catch` autour de l'IPC est suffisant — plus besoin de check de
  forme sur chaque retour.
- Un store qui n'attrape PAS un `NotUnlockedError` voit la promise rejetée
  remonter à `unhandledrejection` — bruyant en dev/Sentry, ce qui est
  préférable à un crash silencieux. Le bug ne peut plus passer inaperçu.
- Sémantique alignée avec le reste de l'écosystème (fetch, axios, etc.).

### Suppression des helpers v1.x

`isGuardedError` et `NOT_UNLOCKED_ERROR` restent exportés (marqués
`@deprecated`) pour ne pas casser un import oublié. Ils ne sont plus
nécessaires en v2.0.0 — vous pouvez les retirer dès que tous les stores
sont migrés.

## Why `name` and not `instanceof`?

Electron sérialise les exceptions thrown depuis un handler `ipcMain.handle`
vers le renderer en :

- préservant `message` et `name`
- **perdant la chaîne de prototypes** (l'objet reçu côté renderer est une
  `Error` plain, pas un `NotUnlockedError`)

Le helper `isNotUnlockedError(err)` checke `err.name === 'NotUnlockedError'`
plutôt que `err instanceof NotUnlockedError` pour cette raison. Côté main
(typiquement dans un test ou un appel direct au handler), les deux
reviennent au même.

## Checklist par app

Pour Prospector V2 / Cadence / Candidate Manager (ou toute future intégration) :

- [ ] `package.json` : passer `@albatros/auth-shared` à `#v2.0.0`
- [ ] `pnpm install`
- [ ] grep `isGuardedError` → remplacer chaque call-site par le pattern
      `try/catch + isNotUnlockedError` (ou supprimer si l'erreur peut
      simplement remonter)
- [ ] grep `Array.isArray(result)` ajouté en patch défensif (cf.
      [TROUBLESHOOTING.md](TROUBLESHOOTING.md) Bug #2) → restaurer le code
      d'origine et ajouter un `try/catch` si nécessaire
- [ ] **Vérifier que chaque store qui fait un IPC guarded a un `try/catch`
      autour de l'await**. Sinon, en ajouter un (silencieux pour
      `NotUnlockedError`, propage les autres).
- [ ] Smoke test : déclencher un lock pendant qu'une fetch est en vol,
      vérifier que la console ne montre plus d'erreur `"X is not
      iterable"` et que l'app revient en état propre après unlock.
- [ ] Build + tests + commit + push.

## Audit avant migration de masse

L'audit `T0` du `PLAN_v2.0.0.md` a confirmé que **aucun consommateur**
(Prospector V2 / Cadence / CM) ne lit `result.success === false` ni
`result.error.code === 'NOT_UNLOCKED'`. La migration n'introduit donc
aucune régression silencieuse — elle simplifie juste le code.

Pour de futures intégrations, refaire le grep avant d'adopter v2.0.0 :

```bash
grep -rn "\\.success\\s*===\\s*false\\|\\.error\\?\\.code\\s*===\\s*['\"]NOT_UNLOCKED" \
  --include='*.ts' --include='*.tsx' src/
```

Si la liste est vide, feu vert.
