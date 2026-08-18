# Écran de déverrouillage — spécification commune aux applications Albatros

Ce document est le **contrat** de l'écran de verrouillage. `auth-shared` ne fournit
aucun composant React : chaque application écrit le sien avec ses propres tokens de
style. Ce qui doit être identique, c'est la structure, les libellés, les états et les
messages — pas le pixel.

**Pourquoi une spec plutôt qu'un composant partagé** : les quatre applications ont
quatre systèmes de style distincts (tokens Tailwind différents, primitives `Button`
différentes). Un composant unique obligerait à ponter les quatre, et transformerait
`auth-shared` en bibliothèque d'interface. La spec coûte moins cher ; en contrepartie
elle n'empêche pas la dérive, d'où l'intérêt de la relire avant toute retouche.

**Pourquoi les écrans doivent se ressembler** : le verrouillage est partagé. Un clic
sur le cadenas — ou une expiration d'inactivité — verrouille les quatre applications
**en même temps**. L'utilisateur se retrouve devant plusieurs fenêtres simultanément
verrouillées : elles doivent être immédiatement reconnaissables et se manipuler de la
même façon.

---

## Structure

Carte centrée (`max-w-sm` ou équivalent), contenu **centré**, dans cet ordre :

| # | Élément | Détail |
|---|---|---|
| 1 | **Badge d'identité** | Cercle ~48 px, fond accent à ~10 %, contenant **le logo de l'application** |
| 2 | **Titre** | « Application verrouillée » — identique partout |
| 3 | **Sous-titre** | « Entrez votre code d'accès pour continuer. » |
| 4 | **Champ** | `type="password"`, placeholder « Code d'accès », `autoFocus`, dans un `<form>` |
| 5 | **Zone de message** | Hauteur réservée, `aria-live="polite"` |
| 6 | **Déverrouiller** | Plein, couleur d'accent, pleine largeur |
| 7 | **Séparateur** | Filet — « ou » — filet |
| 8 | **Windows Hello** | Liseré accent + icône empreinte, pleine largeur |
| 9 | **Code oublié ?** | Lien discret, pleine largeur |

### Le badge porte le logo, pas un cadenas

Le titre reste générique (« Application verrouillée ») dans les quatre applications :
c'est le **logo** qui identifie la fenêtre. Un titre variable (« Cadence verrouillée »)
obligerait à accorder le texte par application pour un gain nul — le logo est plus
rapide à reconnaître qu'une phrase.

### « Code oublié ? », jamais « Mot de passe oublié ? »

Rien dans le système ne s'appelle « mot de passe » : le champ est un **code d'accès**,
et la récupération se fait par question/réponse. Sur un écran de sécurité, la
terminologie doit être exacte.

### Le vocabulaire est « Windows Hello »

Jamais « empreinte digitale » ni « biométrie » : l'API ne permet pas d'exiger une
modalité. Un utilisateur sans capteur mais avec un PIN Hello obtiendra une invite de
PIN — la propriété de sécurité est identique (clé TPM + vérification utilisateur),
seul le confort diffère.

---

## États et messages

Les trois champs de `LockoutStatus` ([src/types.ts](../src/types.ts)) doivent **tous**
être exploités :

```ts
interface LockoutStatus {
  locked_until: string | null      // blocage 30 min après 5 échecs
  attempts_remaining: number       // décompte avant blocage
  required_delay_seconds: number   // délai progressif entre deux tentatives
}
```

| État | Affichage | Champ | Déverrouiller | Hello |
|---|---|---|---|---|
| Nominal | — | actif | actif si code non vide | actif |
| Code erroné | « Code incorrect. » + « Encore N tentative(s) avant blocage. » si `attempts_remaining` < 5 | actif, vidé | actif | actif |
| Délai progressif (`required_delay_seconds` > 0) | « Attendez N s avant la prochaine tentative. » | désactivé | désactivé | actif |
| **Blocage** (`locked_until` futur) | « Application bloquée — réessayez dans `Xmin YYs` », **décompte vivant** | désactivé | désactivé | **désactivé** |
| Vérification du code | — | désactivé | « Vérification… » | actif |
| Invite Hello en cours | — | **actif** | actif | « Vérification… » |
| Hello annulé par l'utilisateur | **aucun message** | actif | actif | actif |
| Hello échoué avec motif | le message renvoyé par le service | actif | actif | actif |

### Le blocage se compte à rebours, il ne s'affiche pas en heure absolue

« Réessayez après 19:42:07 » oblige l'utilisateur à faire la soustraction. Le décompte
(`3min 42s`) est immédiatement lisible et se met à jour chaque seconde. Le `setInterval`
ne tourne **que** pendant un blocage actif, et l'état serveur est rafraîchi à l'échéance.

Format attendu : `Xmin YYs` au-dessus d'une minute, `Ys` en dessous.

### La zone de message a une hauteur réservée

Sans cela, l'apparition d'une erreur décale les boutons vers le bas au moment précis où
l'utilisateur clique. La zone existe toujours ; seul son contenu change.

### `aria-live="polite"` sur la zone de message

Un échec de déverrouillage doit être **annoncé**, pas seulement affiché.

---

## Invariants — ne pas « améliorer »

Ces trois règles ont un coût apparent en confort et une raison mesurée. Les remettre en
cause sans relire cette section, c'est réintroduire un bug déjà payé.

### 1. Hello n'est JAMAIS déclenché au montage

Le bouton doit être cliqué. Une invite Hello levée sans avoir le premier plan est
précisément la condition de `WINBIO_E_INVALID_TICKET` (0x80098044), bug Windows non
corrigé. Mesuré sur poste : **3 échecs sur 5 en arrière-plan, 0 sur 6 au premier plan**.
Le clic garantit le focus.

### 2. Le champ de code reste saisissable pendant l'invite Hello

L'invite dure de 0,3 à 5,6 s (mesuré). Les deux chemins courent en parallèle et le
premier qui aboutit l'emporte ; le résultat tardif de l'autre est ignoré. Bloquer le
champ piégerait l'utilisateur si Hello ne répond jamais.

### 3. Le bouton Hello est masqué, jamais grisé

Condition d'affichage : `biometricEnrolled` **seul**. Ne pas appeler `isSupported()` ici
— c'est asynchrone, et un blob d'enrôlement ne peut exister que si Hello a fonctionné.
Si Hello disparaît ensuite, l'appel échoue en `key-mismatch`, le service détruit le blob
et le bouton s'efface de lui-même : auto-réparation plutôt que sonde à chaque affichage.

Un bouton grisé annoncerait une fonctionnalité qu'on ne peut pas activer depuis cet
écran — l'enrôlement se fait dans les réglages, jamais ici.

---

## Hors périmètre

- **Thème clair/sombre de l'écran** : **volontairement non harmonisé** (décidé le
  18/08/2026). Chaque application conserve le comportement qu'elle avait déjà. Ce
  n'est pas un oubli et ce n'est plus une question ouverte : ne pas y revenir sans
  demande explicite.
- **L'écran de récupération** (question/réponse) : hors de cette spec.
