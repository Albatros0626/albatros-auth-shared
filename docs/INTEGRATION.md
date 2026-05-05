# Intégration de `@albatros/auth-shared` dans une nouvelle app Electron

Guide d'intégration pas-à-pas pour brancher une app Electron sur la mutualisation auth Albatros (mot de passe partagé, déverrouillage cross-app, auto-lock).

**Apps déjà intégrées (servent de référence)** : Prospector V2, Cadence, Candidate Manager.

**Effort estimé** : ~30 minutes pour une intégration propre, ~1h si l'app a déjà un système d'auth local à migrer.

---

## TL;DR

```bash
# 1. Installer le package (≥ v1.2.0 recommandé)
pnpm add github:Albatros0626/albatros-auth-shared#v1.2.0
# (ou npm install --save github:Albatros0626/albatros-auth-shared#v1.2.0)
```

Côté main :
- Créer `electron/auth-context.ts` (facade singleton, ~130 lignes)
- Initialiser au boot avant les handlers IPC
- Ajouter `app.setName('<NomDeLApp>')` au tout début
- Brancher migration + session.watch + idle-watcher
- Adapter les handlers `auth:*` et `secrets:*` pour utiliser les services injectés

Côté renderer :
- Importer le hook `useIdleLock` directement depuis le package (≥ v1.2.0) :
  `import { useIdleLock } from '@albatros/auth-shared/react'` — plus de copie locale à maintenir.
- Store/context auth : ajouter `applyExternalState` + subscribe à `onStateChanged`
- Pour les autres imports renderer, utiliser `@albatros/auth-shared/browser` (pas le main entry) — sinon Vite plante sur les modules Node.

### Pièges courants

**Auto-lock — callbacks instables.** Avant la v1.2.0, passer des arrow functions inline à `useIdleLock` causait une re-création du tracker à chaque render du parent :

```tsx
// ❌ Anti-pattern (v1.1.x : effet recréé à chaque render → timer reset)
useIdleLock({
  timeoutMinutes,
  onLock:    () => { void lock() },
  onActivity:() => { void window.electronAPI.authRecordActivity() },
})
```

À partir de la v1.2.0, le hook utilise `useRef` en interne — vous pouvez passer des arrow functions inline en toute sécurité, l'effet ne se re-run que sur changement de `timeoutMinutes`.

**Erreur `NOT_UNLOCKED` côté store.** Quand un appel IPC `guardedHandle()` court-circuite parce que l'app est verrouillée, le main retourne actuellement (v1.x) un objet `{ success: false, error: { code: 'NOT_UNLOCKED', ... } }`. Si le store le stocke tel quel, les composants crashent ensuite sur `.filter()` / itération. Utiliser `isGuardedError` :

```ts
import { isGuardedError } from '@albatros/auth-shared/browser'

const result = await window.electronAPI.getContacts()
if (isGuardedError(result)) {
  set({ contacts: [] })  // grace : la prochaine fetch (post-unlock) repeuplera
  return
}
set({ contacts: result })
```

> En v2.0.0 le package basculera sur un `throw NotUnlockedError()` — votre `try/catch` autour de l'IPC suffira et `isGuardedError` deviendra inutile. Cf. [PLAN_v2.0.0.md](PLAN_v2.0.0.md).

---

## Prérequis

| Exigence | Pourquoi |
|---|---|
| Electron ≥ 28 | `safeStorage` requis pour le chiffrement DPAPI |
| Node ≥ 20 | Aligné sur les autres apps |
| TypeScript ≥ 5 | Types stricts du package |
| Build CJS pour main | Le package est CJS (`require`-compatible) |
| Build ESM/Vite pour renderer | Vite gère le subpath `/browser` |

L'app doit avoir au minimum :
- Un dossier `electron/` (ou `main/`) pour le code main
- Un `preload.ts` exposant `window.electronAPI` (ou équivalent)
- Un renderer avec un router/auth-state existant

---

## Architecture cible

Une fois intégrée, l'app aura cette structure :

```
electron/
├── auth-context.ts        ← NOUVEAU — facade singleton sur le package
├── main.ts                ← MODIFIÉ — init context + migrations + session sync
├── preload.ts             ← MODIFIÉ — bridge auth + onStateChanged
└── ipc/
    ├── auth.ts            ← MODIFIÉ — handlers utilisent le context
    ├── secrets.ts         ← MODIFIÉ — utilisent le context, clé 'ai.apiKey'
    └── (autres handlers gated via guardedHandle du context)

src/
├── contexts/AuthContext.tsx (ou stores/auth.ts)  ← MODIFIÉ — applyExternalState
├── hooks/useIdleLock.ts                           ← NOUVEAU ou MODIFIÉ
└── App.tsx                                        ← MODIFIÉ — subscribe + wire idle
```

**Stockage sur le PC utilisateur** :

| Emplacement | Contenu | Partagé ? |
|---|---|---|
| `%LOCALAPPDATA%\AlbatrosApps\auth.vault` | Mot de passe + question secrète + politique lockout | ✅ entre apps |
| `%LOCALAPPDATA%\AlbatrosApps\session.bin` | État unlock/lock chiffré DPAPI | ✅ entre apps |
| `%LOCALAPPDATA%\AlbatrosApps\migration.log` | Audit des migrations | ✅ entre apps |
| `%APPDATA%\<NomDeLApp>\secrets.vault` | Clés API spécifiques à l'app | ❌ par app |

---

## Étape 1 : Installation

```bash
# pnpm
pnpm add github:Albatros0626/albatros-auth-shared#v1.1.0

# npm
npm install --save github:Albatros0626/albatros-auth-shared#v1.1.0
```

Le `dist/` est déjà commité dans le repo du package — install zero-config (pas de script `prepare`, pas d'`onlyBuiltDependencies` à allowlister).

---

## Étape 2 : Créer `electron/auth-context.ts`

Copier ce fichier tel quel, en remplaçant `<APP_ID>` et l'allowlist :

```typescript
/**
 * Singleton facade over the @albatros/auth-shared package.
 * Exposes service instances created once at boot via initAuthContext().
 */

import { app, ipcMain, safeStorage, IpcMain, IpcMainInvokeEvent } from 'electron'
import path from 'path'
import {
  createAuthService,
  createSecretsService,
  createAuthState,
  createGuardedHandle,
  createSessionService,
  createIdleWatcher,
  type AuthService,
  type SecretsService,
  type AuthState,
  type SessionService,
  type IdleWatcher,
  type GuardedHandle,
} from '@albatros/auth-shared'

const APP_ID = 'votre-app-id'                              // ⚠️ À ADAPTER (slug stable)
const SECRETS_ALLOWLIST = ['ai.apiKey'] as const            // ⚠️ À ADAPTER (clés que l'app stocke)

export interface AuthContext {
  authService: AuthService
  secretsService: SecretsService
  authState: AuthState
  sessionService: SessionService
  guardedHandle: GuardedHandle
  paths: {
    sharedDir: string
    sharedAuthVault: string
    sharedSessionFile: string
    sharedMigrationLog: string
    localAuthVault: string
    localSecretsVault: string
  }
  startIdleWatcher: (onLock: () => void) => IdleWatcher
}

let context: AuthContext | null = null

function buildPaths(): AuthContext['paths'] {
  const localAppData = process.env.LOCALAPPDATA
    ?? path.join(app.getPath('appData'), '..', 'Local')
  const sharedDir = path.join(localAppData, 'AlbatrosApps')

  const userData = app.getPath('userData')

  return {
    sharedDir,
    sharedAuthVault: path.join(sharedDir, 'auth.vault'),
    sharedSessionFile: path.join(sharedDir, 'session.bin'),
    sharedMigrationLog: path.join(sharedDir, 'migration.log'),
    localAuthVault: path.join(userData, 'auth.vault'),
    localSecretsVault: path.join(userData, 'secrets.vault'),
  }
}

export function initAuthContext(): AuthContext {
  if (context) return context

  const paths = buildPaths()

  const authService = createAuthService({ vaultPath: paths.sharedAuthVault })
  const secretsService = createSecretsService({
    vaultPath: paths.localSecretsVault,
    allowlist: SECRETS_ALLOWLIST,
    safeStorage,
  })
  const authState = createAuthState()
  const sessionService = createSessionService({
    sharedDir: paths.sharedDir,
    appId: APP_ID,
    safeStorage,
  })
  const guardedHandle = createGuardedHandle({ ipcMain, authState })

  context = {
    authService,
    secretsService,
    authState,
    sessionService,
    guardedHandle,
    paths,
    startIdleWatcher: (onLock: () => void) => createIdleWatcher({ sessionService, onLock }),
  }

  return context
}

export function getAuthContext(): AuthContext {
  if (!context) {
    throw new Error('Auth context not initialized — call initAuthContext() first.')
  }
  return context
}

/**
 * Optional: re-exposes the proxy pattern used by Candidate Manager.
 * Useful if your app already has many `ipcMain.handle(...)` calls and
 * you want to gate them all behind a single proxy without source changes.
 */
export function makeGuardedIpcMain(rawIpcMain: IpcMain): IpcMain {
  const { guardedHandle } = getAuthContext()
  return new Proxy(rawIpcMain, {
    get(target, prop, receiver) {
      if (prop === 'handle') {
        return (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
          guardedHandle(channel, listener)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as IpcMain
}
```

**Choix de l'allowlist** :
- Chaque app déclare les clés secrets qu'elle stocke
- Convention : camelCase dotted (`ai.apiKey`, `integrations.lusha.apiKey`, `email.smtp.password`)
- L'allowlist est appliquée strictement : tout `setSecret(key)` avec une clé hors-liste lève une `KeyNotAllowedError`

---

## Étape 3 : Adapter `electron/main.ts`

Au tout début du fichier (avant tous les autres init) :

```typescript
import { app } from 'electron'
import { mkdirSync, existsSync } from 'fs'
import { migrateLocalAuthToShared, type IdleWatcher } from '@albatros/auth-shared'
import { initAuthContext, getAuthContext } from './auth-context'

// Force le nom d'app pour isoler userData en dev
app.setName('Nom De L\'App')                                 // ⚠️ À ADAPTER

let mainWindow: BrowserWindow | null = null
let idleWatcher: IdleWatcher | null = null

function wireSessionSync(): void {
  const ctx = getAuthContext()
  const { authState, sessionService } = ctx

  // Adopter les unlock/lock cross-app
  sessionService.watch((state) => {
    if (!state) return
    if (state.isValid && !authState.isUnlocked()) {
      authState.setUnlocked(true)
    } else if (!state.isValid && authState.isUnlocked()) {
      authState.setUnlocked(false)
    }
  })

  // Pousser les changements d'état au renderer
  authState.onUnlockChange((unlocked) => {
    mainWindow?.webContents.send('auth:state-changed', unlocked)
  })

  // Cycle de vie de l'idle-watcher : start sur unlock, stop sur lock
  authState.onUnlockChange((unlocked) => {
    if (unlocked) {
      idleWatcher?.stop()
      idleWatcher = ctx.startIdleWatcher(() => {
        sessionService.recordLock()
        authState.setUnlocked(false)
      })
      idleWatcher.start()
    } else {
      idleWatcher?.stop()
      idleWatcher = null
    }
  })
}

app.whenReady().then(async () => {
  // 1. Initialiser le context (avant tout handler IPC)
  const ctx = initAuthContext()

  // 2. Créer le dossier partagé si absent
  if (!existsSync(ctx.paths.sharedDir)) {
    mkdirSync(ctx.paths.sharedDir, { recursive: true })
  }

  // 3. Migrer le vault local (si existant) vers le shared dir
  const migration = migrateLocalAuthToShared({
    localVaultPath: ctx.paths.localAuthVault,
    sharedVaultPath: ctx.paths.sharedAuthVault,
    appId: 'votre-app-id',                                   // ⚠️ Même que dans auth-context
    migrationLogPath: ctx.paths.sharedMigrationLog,
  })
  if (migration.outcome === 'conflict-needs-resolution') {
    // Surface un dialog UX (au choix : keep shared / keep local / re-setup)
    console.warn('[auth] vault conflict — keeping shared, leaving local untouched')
  } else if (migration.outcome === 'error') {
    console.error('[auth] migration error:', migration.message)
  }

  // 4. Créer la fenêtre AVANT wireSessionSync (mainWindow doit exister pour webContents.send)
  createWindow()

  // 5. Enregistrer les handlers auth (NON gated — accessibles avant unlock)
  setupAuthHandlers(ipcMain)

  // 6. Si fresh install, optionnellement déverrouiller par défaut
  //    (le SetupPage s'affichera et appellera auth:setup qui re-confirme l'unlock)
  if (!ctx.authService.isSetupComplete()) {
    ctx.authState.setUnlocked(true)
  }

  // 7. Brancher la sync cross-app
  wireSessionSync()

  // 8. Enregistrer les autres handlers (gated via ctx.guardedHandle)
  setupOtherHandlers()
})
```

---

## Étape 4 : Adapter les handlers IPC `auth:*` et `secrets:*`

```typescript
// electron/ipc/auth.ts
import { IpcMain } from 'electron'
import { getAuthContext } from '../auth-context'

export function setupAuthHandlers(ipcMain: IpcMain): void {
  const { authService, authState, sessionService } = getAuthContext()

  ipcMain.handle('auth:isSetupComplete', () => authService.isSetupComplete())

  ipcMain.handle('auth:isUnlocked', () => authState.isUnlocked())

  ipcMain.handle('auth:getRecoveryQuestion', () => {
    try { return { success: true, question: authService.getRecoveryQuestion() } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:getLastCodeChangeDate', () => authService.getLastCodeChangeDate())
  ipcMain.handle('auth:getLockoutStatus', () => authService.getLockoutStatus())

  ipcMain.handle('auth:getLockTimeoutMinutes', () => {
    if (!authService.isSetupComplete()) return null
    return authService.getLockTimeoutMinutes()
  })

  ipcMain.handle('auth:setLockTimeoutMinutes', (_e, minutes: number) => {
    try { authService.setLockTimeoutMinutes(minutes); return { success: true } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  // ⚠️ ORDRE IMPORTANT — recordUnlock AVANT setUnlocked.
  // setUnlocked déclenche en synchrone le restart de l'idle-watcher dont
  // l'initial check lit session.bin. Si session.bin n'a pas encore été
  // mis à jour (lockedAt non-null restant du lock précédent), le watcher
  // re-déclenche onLock immédiatement → l'app se re-locke avant même
  // que verifyCode ne réponde au renderer. Mettre à jour session.bin
  // d'abord garantit que le check voit l'état frais.
  // (À partir de v2.0.1, l'initial check est déféré au prochain
  // macrotask — défense en profondeur — mais l'ordre correct reste
  // recommandé pour les anciennes versions.)
  ipcMain.handle('auth:setup', async (_e, code: string, question: string, answer: string) => {
    try {
      await authService.setup({ code, recoveryQuestion: question, recoveryAnswer: answer })
      sessionService.recordUnlock({ lockTimeoutMinutes: authService.getLockTimeoutMinutes() })
      authState.setUnlocked(true)
      return { success: true }
    } catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:verifyCode', async (_e, code: string) => {
    try {
      const ok = await authService.verifyCode(code)
      if (ok) {
        sessionService.recordUnlock({ lockTimeoutMinutes: authService.getLockTimeoutMinutes() })
        authState.setUnlocked(true)
      }
      return { success: true, ok, lockoutStatus: authService.getLockoutStatus() }
    } catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:verifyCurrentCode', async (_e, code: string) => {
    try { return { success: true, ok: await authService.verifyCurrentCode(code) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:testRecovery', async (_e, answer: string) => {
    try { return { success: true, ok: await authService.testRecovery(answer) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:recover', async (_e, answer: string, newCode: string) => {
    try {
      await authService.recover(answer, newCode)
      sessionService.recordUnlock({ lockTimeoutMinutes: authService.getLockTimeoutMinutes() })
      authState.setUnlocked(true)
      return { success: true }
    } catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:changeCode', async (_e, oldCode: string, newCode: string) => {
    try { await authService.changeCode(oldCode, newCode); return { success: true } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:changeRecovery', async (_e, currentCode: string, q: string, a: string) => {
    try { await authService.changeRecovery(currentCode, q, a); return { success: true } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('auth:lock', () => {
    authState.setUnlocked(false)
    sessionService.recordLock()
    return { success: true }
  })

  ipcMain.handle('auth:recordActivity', () => {
    sessionService.recordActivity()
    return { success: true }
  })
}
```

```typescript
// electron/ipc/secrets.ts (exemple si l'app stocke ai.apiKey)
import { IpcMain } from 'electron'
import { getAuthContext } from '../auth-context'

export function setupSecretsHandlers(ipcMain: IpcMain): void {
  // Note: si vous utilisez le proxy makeGuardedIpcMain, ces handlers seront
  // automatiquement gated. Sinon, utilisez ctx.guardedHandle directement.
  ipcMain.handle('secrets:getApiKey', async () => {
    return getAuthContext().secretsService.getSecret('ai.apiKey') || ''
  })
  ipcMain.handle('secrets:setApiKey', async (_e, value: string) => {
    try {
      const { secretsService } = getAuthContext()
      if (value) secretsService.setSecret('ai.apiKey', value)
      else secretsService.deleteSecret('ai.apiKey')
      return { success: true }
    } catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('secrets:hasApiKey', async () => {
    return getAuthContext().secretsService.hasSecret('ai.apiKey')
  })
}
```

**Convention IPC** :
- `auth:verifyCode` (pas `auth:verify`) — alignement cross-app
- Tous les channels en camelCase
- `auth:*` et `secrets:has/set/delete` sont accessibles AVANT unlock (pour wizard setup + LockPage)
- `secrets:get` et tous les autres handlers business doivent être gated

---

## Étape 5 : Adapter `preload.ts`

Ajouter les nouveaux channels et l'event listener :

```typescript
const authAPI = {
  // ... handlers existants
  recordActivity: () => ipcRenderer.invoke('auth:recordActivity'),
  getLockTimeoutMinutes: () => ipcRenderer.invoke('auth:getLockTimeoutMinutes'),
  setLockTimeoutMinutes: (minutes: number) =>
    ipcRenderer.invoke('auth:setLockTimeoutMinutes', minutes),

  /** Subscribe to cross-app state changes pushed from main. */
  onStateChanged: (callback: (unlocked: boolean) => void): (() => void) => {
    const handler = (_evt: unknown, unlocked: boolean): void => callback(unlocked)
    ipcRenderer.on('auth:state-changed', handler)
    return () => { ipcRenderer.removeListener('auth:state-changed', handler) }
  },
}
```

Si l'app a un `electron.d.ts` (déclaration globale Window.electronAPI), ajouter les types correspondants.

---

## Étape 6 : Hook `useIdleLock` côté renderer

Créer ou mettre à jour `src/hooks/useIdleLock.ts` :

```typescript
import { useEffect } from 'react'
// ⚠️ IMPORTANT : importer depuis /browser, PAS depuis @albatros/auth-shared
//                Le main entry pull crypto/fs/electron qui ne sont pas dans le browser bundle.
import { createActivityTracker } from '@albatros/auth-shared/browser'

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel',
]
const IPC_THROTTLE_MS = 1_000

export interface UseIdleLockOpts {
  timeoutMinutes: number
  onLock: () => void
  onActivity?: () => void
}

export function useIdleLock(opts: UseIdleLockOpts): void {
  const { timeoutMinutes, onLock, onActivity } = opts

  useEffect(() => {
    if (!timeoutMinutes || timeoutMinutes <= 0) return

    const tracker = createActivityTracker({
      timeoutMs: timeoutMinutes * 60_000,
      onIdle: onLock,
    })
    tracker.start()

    let lastIpcCall = 0
    const handler = (): void => {
      tracker.recordActivity()
      const now = Date.now()
      if (now - lastIpcCall > IPC_THROTTLE_MS) {
        lastIpcCall = now
        onActivity?.()
      }
    }
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, handler))

    return () => {
      tracker.stop()
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, handler))
    }
  }, [timeoutMinutes, onLock, onActivity])
}
```

---

## Étape 7 : Intégrer dans le store/context auth

Que l'app utilise Zustand, Redux ou React Context, le pattern est le même :

1. Ajouter une action `applyExternalState(unlocked: boolean)` qui met à jour le flag local
2. Subscribe à `window.electronAPI.auth.onStateChanged` au mount, appeler `applyExternalState`

**Exemple Zustand** (pattern Prospector / Cadence) :
```typescript
applyExternalState: (unlocked) => {
  set({ isUnlocked: unlocked })
},
```

**Exemple React Context** (pattern Candidate Manager) :
```typescript
const applyExternalState = useCallback((unlocked: boolean) => {
  setStage((current) => {
    if (current === 'loading' || current === 'setup') return current
    return unlocked ? 'unlocked' : 'locked'
  })
}, [])

useEffect(() => {
  return window.electronAPI.auth.onStateChanged((unlocked) => {
    applyExternalState(unlocked)
  })
}, [applyExternalState])
```

---

## Étape 8 : Wirer le `useIdleLock` dans le composant racine

Dans `App.tsx` (ou équivalent) :

```typescript
import { useEffect, useState } from 'react'
import { useIdleLock } from './hooks/useIdleLock'
import { useAuth } from './contexts/AuthContext' // ou useAuthStore

function App() {
  const { isUnlocked, lock, applyExternalState } = useAuth()
  const [lockTimeoutMinutes, setLockTimeoutMinutes] = useState(10)

  // Charger le timeout depuis le vault après unlock
  useEffect(() => {
    if (!isUnlocked) return
    void window.electronAPI.auth.getLockTimeoutMinutes().then((value) => {
      if (typeof value === 'number') setLockTimeoutMinutes(value)
    })
  }, [isUnlocked])

  // Subscribe aux pushes cross-app
  useEffect(() => {
    return window.electronAPI.auth.onStateChanged((unlocked) => {
      applyExternalState(unlocked)
    })
  }, [applyExternalState])

  // Auto-lock par inactivité
  useIdleLock({
    timeoutMinutes: isUnlocked ? lockTimeoutMinutes : 0,
    onLock: () => { void lock() },
    onActivity: () => { void window.electronAPI.auth.recordActivity() },
  })

  // ... le reste du routing/UI
}
```

---

## Étape 9 : UI de configuration du timeout (optionnel)

Si vous voulez exposer la durée d'auto-lock dans les paramètres :

```typescript
// Lecture
const minutes = await window.electronAPI.auth.getLockTimeoutMinutes()

// Écriture
await window.electronAPI.auth.setLockTimeoutMinutes(15)
```

Valeurs typiques : 2, 5, 10, 30 minutes. `0` = désactivé.

---

## Migrations spécifiques selon votre app

### Si l'app n'a JAMAIS eu d'auth locale

Rien à faire au-delà des étapes ci-dessus. L'utilisateur verra le SetupPage la première fois.

### Si l'app avait son propre `auth.vault` local

Le `migrateLocalAuthToShared` à l'étape 3 s'en occupe automatiquement. Le vault local est déplacé vers `%LOCALAPPDATA%\AlbatrosApps\auth.vault` et l'original est renommé `.migrated.bak`.

### Si l'app a un `secrets.vault` avec des clés au mauvais nom

Exemple : Cadence avait `'ia_cle'` (français), Candidate Manager avait `'api_key'` (générique). Standardisé en `'ai.apiKey'`.

Ajoutez une migration one-shot dans `main.ts` :

```typescript
function migrateApiKeyName(): void {
  const ctx = getAuthContext()
  const vaultPath = ctx.paths.localSecretsVault
  if (!existsSync(vaultPath)) return
  try {
    const raw = readFileSync(vaultPath, 'utf-8')
    const parsed = JSON.parse(raw) as { version: number; secrets: Record<string, string> }
    if (!parsed.secrets?.['ANCIEN_NOM']) return
    if (parsed.secrets['ai.apiKey']) {
      delete parsed.secrets['ANCIEN_NOM']
    } else {
      parsed.secrets['ai.apiKey'] = parsed.secrets['ANCIEN_NOM']
      delete parsed.secrets['ANCIEN_NOM']
    }
    const tmp = `${vaultPath}.tmp`
    writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 })
    renameSync(tmp, vaultPath)
  } catch (err) { console.error('[secrets] rename failed:', err) }
}
```

### Si l'app stockait sa policy idle-lock dans une table DB

Exemple : Cadence avait `security_idle_minutes` dans `parametres`. Migrer vers le vault :

```typescript
function migrateIdleTimeout(queries: Queries): void {
  const { authService } = getAuthContext()
  if (!authService.isSetupComplete()) return
  try {
    const params = queries.parametres.getAll()
    const raw = params['security_idle_minutes']
    if (!raw) return
    const parsed = parseInt(raw, 10)
    if (Number.isNaN(parsed) || parsed < 0) return
    authService.setLockTimeoutMinutes(parsed)
    queries.parametres.set('security_idle_minutes', '')
  } catch (err) { console.error('[auth] idle migration failed:', err) }
}
```

---

## Smoke test après intégration

Une fois le code déployé, vérifier manuellement (en dev ou avec une 2ème app installée) :

1. **Boot fresh install** :
   - Lancer l'app, voir SetupPage
   - Saisir code + question secrète + réponse → unlock OK
   - Vérifier que `%LOCALAPPDATA%\AlbatrosApps\auth.vault` existe
   - Vérifier que `%LOCALAPPDATA%\AlbatrosApps\session.bin` existe
   - Vérifier que `%LOCALAPPDATA%\AlbatrosApps\migration.log` contient une ligne JSONL avec `outcome: "no-op-fresh-install"` ou `"migrated"`

2. **Unlock cross-app** (avec une autre app Albatros installée) :
   - Avec les 2 apps fermées : ouvrir app A → LockPage → unlock
   - Ouvrir app B → devrait passer directement en état unlocked (pas de LockPage)

3. **Lock cross-app** :
   - Les 2 apps ouvertes
   - Cliquer "Verrouiller" dans app A → app B doit lock dans la seconde

4. **Auto-lock par inactivité** :
   - Définir le timeout à 2 min via les paramètres
   - Laisser l'app ouverte sans interaction
   - Vérifier que LockPage apparaît après 2 minutes

5. **Lockout après 5 codes faux** :
   - Saisir 5 codes incorrects
   - Vérifier que le lockout 30 min se déclenche

6. **Recovery** :
   - Cliquer "Mot de passe oublié" → saisir question secrète + nouveau code
   - Vérifier l'unlock + vault mis à jour

---

## Convention de nommage `appId`

Le `appId` que vous passez à `createSessionService` et à `migrateLocalAuthToShared` est un slug stable identifiant l'app dans le journal de session. Convention : kebab-case minuscules.

| App | appId |
|---|---|
| Prospector V2 | `prospector` |
| Cadence | `cadence` |
| Candidate Manager | `candidate-manager` |

Choisissez un slug court qui ne changera plus.

---

## Versioning et coordination de déploiement

Le format du `auth.vault` est versionné (`version: 2` actuellement, avec `schemaCompat: [1, 2]`). Tant que le package reste sur la majeure v1, les apps peuvent être mises à jour indépendamment.

**Si v2.0.0 du package sort** (changement breaking) : toutes les apps doivent être mises à jour ensemble sur le même PC. Sinon les versions anciennes verront `VaultVersionUnsupportedError`.

---

## Pièges courants

| Symptôme | Cause | Fix |
|---|---|---|
| Renderer écran blanc, console "Cannot find module 'crypto'" | Import depuis `@albatros/auth-shared` au lieu de `/browser` | Changer l'import en `@albatros/auth-shared/browser` |
| `getAuthContext()` throw "not initialized" | Handler IPC importé avant `initAuthContext()` | Appeler `initAuthContext()` dans `app.whenReady()` AVANT tout `setupHandlers()` |
| Cross-app lock ne propage pas | `mainWindow` undefined au moment du `webContents.send` | Appeler `wireSessionSync()` APRÈS `createWindow()` |
| Tests échouent : "Cannot find module 'electron'" | Mock electron incomplet | Ajouter `safeStorage` au mock electron : `{ isEncryptionAvailable, encryptString, decryptString }` |
| pnpm "approve-builds" demandé pour le package | Ancienne version sans `dist/` commité | Mettre à jour vers v1.0.1+ |
| Idle-lock ne se déclenche pas | `useIdleLock` appelé alors que `timeoutMinutes = 0` | Vérifier que la valeur lue depuis le vault est > 0 |

---

## Référence rapide — API publique du package

### Main process (depuis `@albatros/auth-shared`)

| Symbole | Description |
|---|---|
| `createAuthService({ vaultPath })` | Factory — service auth complet |
| `createSecretsService({ vaultPath, allowlist, safeStorage })` | Factory — vault DPAPI |
| `createAuthState()` | Factory — flag isUnlocked + onUnlockChange |
| `createGuardedHandle({ ipcMain, authState })` | Factory — wrapper IPC `NOT_UNLOCKED` |
| `createSessionService({ sharedDir, appId, safeStorage })` | Factory — session.bin partagé |
| `createIdleWatcher({ sessionService, onLock, pollMs? })` | Watcher main pour expiration |
| `migrateLocalAuthToShared({ ... })` | One-shot legacy → shared |
| `detectMigrationConflict({ ... })` | Vérifie si conflit (les 2 vaults existent) |
| `appendMigrationLog(logPath, entry)` | Append JSONL |
| `validateCode(code)` | Pure — règles de mot de passe |
| `normalizeAnswer(s)` | Pure — normalisation question secrète |
| Constantes : `PBKDF2_ITERATIONS`, `LOCKOUT_THRESHOLD`, `DEFAULT_LOCK_TIMEOUT_MINUTES`, etc. |
| Erreurs : `VaultVersionUnsupportedError`, `KeyNotAllowedError`, `DPAPIUnavailableError`, etc. |

### Renderer (depuis `@albatros/auth-shared/browser`)

| Symbole | Description |
|---|---|
| `createActivityTracker({ timeoutMs, onIdle })` | Pure JS — détecteur d'inactivité |
| `RECOVERY_QUESTIONS` | Liste pré-définie des questions secrètes |
| `CUSTOM_QUESTION_MIN_LENGTH` | 10 |
| `RECOVERY_ANSWER_MIN_LENGTH` | 4 |
| Type `LockoutStatus` | Pour les types renderer |

---

## Liens utiles

- Repo du package : https://github.com/Albatros0626/albatros-auth-shared
- README du package : explique le projet, l'install, les exports
- CHANGELOG : trace l'évolution des versions
- Tests cross-process : `test/integration/multi-app.test.ts` — référence pour comprendre le contrat fichier

---

## Checklist d'intégration finale

- [ ] `pnpm add github:Albatros0626/albatros-auth-shared#v1.x.x`
- [ ] Créer `electron/auth-context.ts` (copier-adapter le template)
- [ ] Choisir un `appId` unique (kebab-case)
- [ ] Définir l'allowlist des secrets de l'app
- [ ] Ajouter `app.setName('<NomDeLApp>')` au top de main
- [ ] Initialiser `initAuthContext()` dans `app.whenReady()` AVANT tout handler
- [ ] Appeler `migrateLocalAuthToShared(...)` après init
- [ ] Brancher `wireSessionSync()` après `createWindow()`
- [ ] Adapter les handlers `auth:*` et `secrets:*` pour utiliser le context
- [ ] Si l'app utilise un `makeGuardedIpcMain` proxy : le copier depuis le template
- [ ] Ajouter `recordActivity`, `getLockTimeoutMinutes`, `setLockTimeoutMinutes`, `onStateChanged` au preload
- [ ] Mettre à jour les types `electron.d.ts` (si présents)
- [ ] Créer/mettre à jour `useIdleLock` avec import depuis `/browser`
- [ ] Ajouter `applyExternalState` au store/context auth
- [ ] Subscribe à `onStateChanged` dans `App.tsx`
- [ ] Wire `useIdleLock` avec `recordActivity`
- [ ] Migrations spécifiques (si applicable) : path secrets vault, nom de clé, idle timeout DB
- [ ] Supprimer les fichiers locaux obsolètes (auth-state, services/auth-service, services/secrets-service, ipc/guarded-handle)
- [ ] `pnpm typecheck` propre
- [ ] `pnpm test` vert
- [ ] Smoke manuel (voir section dédiée)
