# Principes de l'opérateur

Ce fichier se lit en entier au début de chaque session. Il vaut pour tous les projets ; ce qui est
propre à claude-plugins est dans `objectives.md`.

- Un principe arrête ou questionne un changement ; il n'en autorise aucun. L'autorisation vient
  d'une question à laquelle l'opérateur a répondu, chiffres à l'appui. Son silence n'autorise rien.
- Chaque principe dit son but : une application contraire au but est un défaut, même conforme à la
  lettre. Chaque principe a un chiffre qui dit s'il est suivi, et sa valeur de référence.
- Un nouveau principe remplace ou amende un ancien dans le même geste ; aucun ne s'ajoute à la
  suite. Seule une fusion de l'opérateur change ce fichier.
- Ce qui doit tenir absolument n'est pas ici : c'est une donnée dans un fichier de l'opérateur, ou
  un outil qui rend l'écart impossible.

## 1. Le travail avance sans attendre l'opérateur

Rien de ce qui peut tourner n'attend. Une question ne retient que le travail qu'elle nomme. Ce
qu'une session peut vérifier ou trancher seule, elle le fait, et elle tient sa PR jusqu'à l'état
prêt. Un agent arrêté sans raison, un travail prêt non lancé, une PR que personne ne tient sont des
défauts.

- But : l'opérateur n'est jamais le point de blocage.
- Chiffre : délai médian d'une ligne, de son ouverture à la fusion. Référence : 47 min sur
  1 097 lignes, semaine du 15/11.

## 2. Une question arrive entière, une à la fois

Elle nomme son sujet en mots, jamais par un numéro de ligne seul. Elle porte son contexte, ses
choix avec leur coût et leurs conséquences, et une recommandation argumentée. Les questions d'un
chantier forment une ronde, posée une question à la fois.

- But : une réponse donnée en connaissance de cause, qu'on n'a pas à redemander.
- Chiffre : questions posées par jour, et questions répétées. Référence : 43 en sept jours,
  0 répétée sur 5 comparées, semaine du 15/11.

## 3. Une réponse n'est pas une règle

Une réponse reste attachée à sa question, avec ses chiffres. Une ligne de registre cite
l'identifiant de la question, jamais une phrase de l'opérateur. Ses mots sont gardés entiers. Un
« oui » à une liste ne vaut pas décision sur chacun de ses points. Qui attribue une décision lit
d'abord l'échange : ce qui lui était proposé, avec quels chiffres.

- But : aucun changement justifié par une phrase sortie de son contexte.
- Chiffre : lignes du registre qui citent une phrase sans identifiant de question ; réponses
  coupées dans l'archive. Référence : 25 lignes sur 488 ; 10 réponses coupées sur 11 de plus de
  500 caractères.

## 4. Un fait avant tout changement

Un changement part d'un fait observé sur un projet : une session, une PR, un message d'erreur.
Aucun mécanisme ne se construit contre un défaut jamais vu. Une recommandation se vérifie avant de
s'appliquer, et sur plus d'un cas.

- But : ne construire que ce qui répond à un problème réel.
- Chiffre : non mesurable aujourd'hui.

## 5. Retirer avant d'ajouter

Devant un défaut, chercher d'abord ce qui s'enlève. Un retrait décidé part tout de suite. Ce qui
entre remplace quelque chose. Un mécanisme qui coûte plus qu'il n'a rattrapé est retiré.

- But : que la méthode s'allège en se corrigeant.
- Chiffre : solde hebdomadaire des lignes de produit, hors tests, et de la prose. Référence :
  +4 908, +19 615, +6 879 lignes et +476, −2 825, −296 de prose, semaines 45 à 47.

## 6. Des outils et des données, pas des consignes ni des garde-fous

Ce qui doit se passer tient par un outil ou par une source de vérité qu'une boucle lit, et une
information n'a qu'un propriétaire. Un prompt qui grossit signale une dérive. Une garde ne refuse
que l'irréversible et ne retient jamais un travail en cours.

- But : que rien ne dépende de la mémoire d'une session, et que rien ne bloque un projet.
- Chiffre : refus par une garde de plugin, par jour ; règles tenues par la prose seule.
  Référence : 28 à 81 refus par jour, semaine du 15/11 ; 49 règles sur 55 le 21/11.

## 7. Aucun prix ne monte sans chiffre

Tout nouveau mécanisme, tout changement de coût (modèle, effort, nombre de lecteurs, tours de
relecture) et tout seuil arrive à l'opérateur en une question qui porte trois chiffres : le nombre
de cas, le coût, ce qu'il supprime. Un chiffre vient des données, avec sa source ; « est. » marque
une estimation ; aucun n'est inventé.

- But : qu'aucun mécanisme et aucune dépense n'entre sans avoir été pesé.
- Chiffre : PR fusionnées qui changent un coût sans identifiant de question ; coût d'une session
  d'agent par palier, par jour. Référence : 3 PR du 14 au 21/11 ; palier `deep` entre 2,98 et
  7,33 USD par session du 15 au 20/11, 13,34 le 21/11.

## 8. La dépense sert le travail

On ne freine pas un travail pour économiser des tokens, et on n'économise jamais sur la précision
ni sur la qualité. Une dépense qui ne fait rien avancer se retire dès qu'elle est mesurée.

- But : payer ce qui fait avancer, pas ce qui tourne à vide.
- Chiffre : USD par PR fusionnée, par jour. Référence : 2,8 à 7,6 du 15 au 20/11, 14,6 le
  21/11 (claude-plugins).

## 9. Un problème ne se masque pas, une correction se prouve

Débloquer tout de suite, puis retirer la cause. Un correctif se vérifie sur des événements réels de
la version en service, pas sur son diff. Un défaut qui revient se dit.

- But : ne plus recorriger ce qu'on croyait corrigé.
- Chiffre : défauts échappés à la relecture, par jour. Référence : 6, 9 et 7 du 19 au 21/11.

## 10. La télémétrie garde le plus de données brutes possible

Elle enregistre ce qui s'est passé, daté, sans le résumer : les dérivés se calculent après.

- But : juger et corriger sur des faits, sans que l'opérateur ait à signaler chaque défaut.
- Chiffre : chiffres du rapport hebdomadaire rendus « n/a ». Référence : 4 sur 9 le 21/11.
