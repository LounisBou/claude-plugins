# The supervision pane — the behaviour expected

The operator's own description, dictated on 2026-11-15, word for word. It is the reference the pane
is checked against; a session's summary of it is not.

## His words

« Donc le volet, on parle bien du panel de supervision. La problématique, c'est que il ne fonctionne
pas comme attendu. Et alors je vais décrire le fonctionnement attendu de ce panel de supervision pour
qu'on soit bien clair. Et là, on parle vraiment d'une description, d'un design que je vais te donner.
Et ça peut être enregistré comme étant une base à laquelle on peut se référer. Donc le fonctionnement
du panel de supervision. Quand il est ouvert, ce panel de supervision, sur un coordinateur, parce que
le panel de supervision, c'est un panel qu'on peut ouvrir sur un coordinateur. Quand il est ouvert,
les questions qui sont remontées par les agents via les orchestrateurs ou directement par les
orchestrateurs au coordinateur arrivent dans ce panel pour pouvoir fluidifier et regrouper les
questions. Les questions sont donc posées dans ce panel, j'y réponds à travers ce panel s'il est
ouvert. S'il n'est pas ouvert, les questions arrivent directement dans la conversation du
coordinateur. En aucun cas, si le panel est ouvert et ou fermé, peu importe si le panel est ouvert ou
fermé, les questions ne devraient pas être dans les sessions de coordination. Je me réexprime pour que
ce soit bien clair. Dans tous les cas, peu importe dans quel état est le panel de supervision ouvert
ou fermé, les questions doivent apparaître et je dois pouvoir y répondre dans les sessions
d'orchestration. Mais ces questions qui sont dans les sessions d'orchestration et qui doivent
également remonter dans la session du coordinateur si ce coordinateur est ouvert, doivent à partir du
moment ou le panneau est ouvert, arriver dans ce panneau et pas dans la session de coordinateur »

Asked two precisions (does a question answered in the orchestrator's session leave the pane; is an
answer given in the pane shown in the orchestrator's session), he added:

« Oui, peu importe où je réponds. Donc là, je réponds à tes deux précisions que tu demandes sur le
panneau de supervision. Peu importe où je réponds. Si je réponds dans le panneau de supervision, la
question disparaît automatiquement de l'orchestrateur et du panneau de supervision. Si le panneau de
supervision était fermé et que je réponds à l'orchestrateur, la question disparaît de la session du
coordinateur. Si le panneau de supervision était ouvert et que je réponds à l'orchestrateur, la
question disparaît du panneau de supervision. Bref, peu importe où apparaît la question, elle est
considérée comme répondue et elle disparaît automatiquement des autres endroits, peu importe
l'endroit où j'y réponds. »

## A session's reading (not his words), for checking

| Where the question shows | Rule |
|---|---|
| The asking orchestrator's session | always, whatever the pane's state, and he can answer there |
| The coordinator's pane | when a coordinator runs and its pane is open; then not in the coordinator's conversation |
| The coordinator's conversation | when a coordinator runs and its pane is closed |

Answered in any one of these places, the question is answered everywhere: it leaves the pane, the
coordinator's conversation is told it is settled, and the asking orchestrator receives the answer.

Open, against his description: a question its sender marks urgent is also due in the coordinator's
conversation while the pane is open (`isDue`, `plugins/orchestrator/hooks/round.ts`). His words do not
speak of urgency; the code keeps the exception until he says.
