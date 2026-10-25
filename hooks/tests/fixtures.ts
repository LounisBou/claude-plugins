// hooks/tests/fixtures.ts
// Texts the pane met on the operator's machine, kept verbatim. The French in them is the
// sender's own words: a fixture of the real entry, under the repository's exemption for a
// fixture that checks the handling of non-ASCII text.

// The entry an orchestrator wrote on 2026-10-25: two questions in the decide shape, numbered
// by the sender out of a wave of four, each with its fields, its choices and its recommendation.
export const TWO_QUESTIONS = [
  "**Question 3 sur 4**",
  "_Sujet_ : numéro de version de la v2 de speculoos (migration progressive vers TypeScript, voie B que vous avez retenue)",
  "_Contexte_ : d'après plan-v2.md, l'API publique ne change pas : mêmes exports, mêmes signatures, mêmes comportements. Les applications n'ont rien à migrer. Seule exception : le back-office devra retirer quatre directives `@ts-expect-error` devenues inutiles, sinon son build casse.",
  "_Question_ : quel numéro porte la version convertie en TypeScript ?",
  "_Choix_ :",
  "- **A** : 1.15.0, puis des 1.x. L'API est inchangée, donc la montée reste sans rupture pour les applications.",
  "- **B** : 2.0.0, pour marquer la réécriture, au prix de signaler une rupture qui n'existe pas dans l'API.",
  "_Recommandation_ : A. Le numéro reflète l'API, et une 2.0.0 obligerait chaque application à une montée majeure qui ne change rien pour elle.",
  "",
  "**Question 4 sur 4**",
  "_Sujet_ : rythme de publication de la v2",
  "_Contexte_ : le plan découpe la conversion en modules (api-client, store et clone, filtres, mercure, hydra), une PR par module, puis une PR de release taguée par la CI, puis la montée de version dans le BO et le FO.",
  "_Question_ : publie-t-on une release par module converti, ou une seule à la fin ?",
  "_Choix_ :",
  "- **A** : une release par module converti. Chaque étape arrive en production et y est validée, au prix de plus de montées de version dans le BO et le FO.",
  "- **B** : une seule release à la fin. Une seule montée de version par application, mais tout le risque arrive d'un coup.",
  "_Recommandation_ : A. Une étape publiée isole la régression éventuelle d'un module, et la chaîne de livraison réparée en 1.14 rend chaque release bon marché.",
].join('\n')

// The blocks text of a row the operator reported on 2026-10-25, its references glued by a slash.
export const GLUED_BLOCKS = 'merge of infra#195/infra#196 (staging lot content), E2E waiver for geo-git-flow#21/geo-git-flow#22'

// The shape `/orchestrator-decide` step 2 writes, in the operator's language: a bold line
// holding the sender's own numbering, labelled fields, the choices, the recommendation. The
// fixture is French on purpose: it checks that labels are read by their shape, accents and
// all, never by an English word list. Kept here with its expected strings, under the fixture
// exemption for accented text.
export const SHAPED = [
  'Décision notée : B, la vague continue.',
  '',
  '**Question 5 sur 6**',
  '_Sujet_ : la numérotation des questions du pane',
  '_Contexte_ : le pane affiche « 1 sur 1 » et « 5 sur 6 ».',
  'Deux numéros pour une seule question.',
  '_Question_ : laquelle garder ?',
  '_Propositions_ :',
  '- **A** : celle de l\'orchestrateur — elle suit sa vague',
  '- **B** : celle du pane — elle compte la file',
  '_Recommandation de l\'orchestrateur_ : A — une seule numérotation, la sienne',
  '',
  'Tu décides : A ou B ?',
].join('\n')

// What the shaped question reads as, verbatim.
export const SHAPED_SUBJECT = 'la numérotation des questions du pane'
export const SHAPED_RECOMMENDATION = 'A — une seule numérotation, la sienne'
export const SHAPED_CONTEXT = 'le pane affiche « 1 sur 1 » et « 5 sur 6 ».\nDeux numéros pour une seule question.'

// Texts of TWO_QUESTIONS' choices and recommendations, as the pane reads them.
export const FIRST_A = "1.15.0, puis des 1.x. L'API est inchangée, donc la montée reste sans rupture pour les applications."
export const FIRST_B = "2.0.0, pour marquer la réécriture, au prix de signaler une rupture qui n'existe pas dans l'API."
export const SECOND_A = "une release par module converti. Chaque étape arrive en production et y est validée, au prix de plus de montées de version dans le BO et le FO."
export const SECOND_B = "une seule release à la fin. Une seule montée de version par application, mais tout le risque arrive d'un coup."
export const SECOND_RECOMMENDATION_START = 'A. Une étape publiée'
