// The deploy list: which repository may be deployed to which environment with no further word of
// the operator, and the commands each repository declares as its deploys, so that a Bash line or a
// Skill call is read as one. Pure functions only: register.ts keeps the file and answers the calls.
// A deploy of an undeclared path is not recognised here: the host's own protections stand behind it.

import { DEPLOY_ENVS, type DeployEnv } from '../core/consent-record.ts'
import { simpleCommands } from '../core/shell.ts'

// The list's file, in the plugin's data directory beside auto-merge.json.
export const AUTO_DEPLOY_FILE = 'auto-deploy.json'
// Auto-deploy as the operator writes it: « auto-deploy », « auto deploy », « autodeploy », « auto-déploiement ».
export const AUTO_DEPLOY_WORD = /auto[-\s]?(deploy|d[ée]ploi)/i

// One entry of the list: the repository may be deployed to the environment.
export type Grant = { repo: string; env: DeployEnv }

// How a repository declares one of its deploys.
export type Declared =
  // A command by its first words, for one environment: `composer deploy:api:prod`.
  | { repo: string; kind: 'command'; argv: string[]; env: DeployEnv }
  // A script by the end of its path, run alone or under an interpreter; the environment is a later word of the call.
  | { repo: string; kind: 'script'; path: string }
  // `gh workflow run <workflow>`; the environment is the value of its `input` field.
  | { repo: string; kind: 'workflow'; workflow: string; input: string }
  // A skill, by its name, for one environment.
  | { repo: string; kind: 'skill'; name: string; env: DeployEnv }

// The file as the module reads it.
export type DeployList = { grants: Grant[]; declared: Declared[] }

// A deploy a call makes: the repository it names, its environment (undefined when the call does not
// give one the list knows) and what the call is, as the refusal says it.
export type Deploy = { repo: string; env: DeployEnv | undefined; what: string }

const ENV_NAMES: Record<string, DeployEnv> = {
  dev: 'dev', development: 'dev', staging: 'staging', stage: 'staging', prod: 'prod', production: 'prod',
}
const INTERPRETERS = /^(.*\/)?(bash|sh|zsh|dash|php|node|python3?|ruby)$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** The environment a word names (`staging`, `production`…), or undefined. */
export function envOf(word: unknown): DeployEnv | undefined {
  return typeof word === 'string' ? ENV_NAMES[word.trim().toLowerCase()] : undefined
}

/** The declaration `raw` holds, or a sentence saying what is wrong with it. */
export function parseDeclared(raw: unknown): Declared | string {
  if (!isObject(raw)) return 'a declared command is an object'
  const { repo, kind } = raw
  if (typeof repo !== 'string' || !REPO.test(repo)) return 'a declared command names its repository as owner/name'
  if (kind === 'command') {
    const { argv, env } = raw
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every(isText)) return 'a "command" declares its first words: {"argv": ["composer", "deploy:api:prod"], "env": "prod"}'
    const named = envOf(env)
    return named ? { repo, kind, argv: argv.map(String), env: named } : 'a "command" names its environment: dev, staging or prod'
  }
  if (kind === 'script') return isText(raw.path) ? { repo, kind, path: raw.path } : 'a "script" names the end of its path: {"path": "scripts/deploy.sh"}'
  if (kind === 'workflow') {
    return isText(raw.workflow) && isText(raw.input)
      ? { repo, kind, workflow: raw.workflow, input: raw.input }
      : 'a "workflow" names its file and its environment input: {"workflow": "deploy.yml", "input": "environment"}'
  }
  if (kind === 'skill') {
    const named = envOf(raw.env)
    return isText(raw.name) && named ? { repo, kind, name: raw.name.replace(/^\//, ''), env: named } : 'a "skill" names itself and its environment: {"name": "mygeo-deploy-prod", "env": "prod"}'
  }
  return 'a declared command is a "command", a "script", a "workflow" or a "skill"'
}

/** The list `raw` holds (the file's object), or a sentence saying what is wrong with it. */
export function parseDeployList(raw: unknown): DeployList | string {
  if (!isObject(raw)) return 'the file is not an object'
  const grants: Grant[] = []
  for (const entry of raw.repositories ?? []) {
    const env = isObject(entry) ? envOf(entry.env) : undefined
    if (!isObject(entry) || typeof entry.repo !== 'string' || !REPO.test(entry.repo) || env === undefined || env !== entry.env) {
      return '"repositories" is not a list of {"repo": "owner/name", "env": "dev"|"staging"|"prod"}'
    }
    grants.push({ repo: entry.repo, env })
  }
  const declared: Declared[] = []
  for (const entry of raw.commands ?? []) {
    const one = parseDeclared(entry)
    if (typeof one === 'string') return '"commands": ' + one
    declared.push(one)
  }
  return { grants, declared }
}

/** Whether the list grants the deploy, the repository compared as GitHub does. */
export function granted(list: DeployList, repo: string, env: DeployEnv): boolean {
  return list.grants.some((g) => g.env === env && g.repo.toLowerCase() === repo.toLowerCase())
}

const baseName = (word: string): string => word.replace(/^.*\//, '')
const endsWithPath = (word: string, path: string): boolean => word === path || word.endsWith('/' + path.replace(/^\.?\//, ''))

// The value a `-f name=value` style option of gh gives to a field, the last setting winning.
function fieldValue(argv: string[], name: string): string | undefined {
  let value: string | undefined
  for (let k = 0; k < argv.length; k++) {
    const word = argv[k]
    const long = /^--(?:raw-)?field=(.*)$/.exec(word)
    const set = long ? long[1] : /^(?:-f|-F|--field|--raw-field)$/.test(word) ? argv[++k] : undefined
    if (set !== undefined && set.startsWith(name + '=')) value = set.slice(name.length + 1)
  }
  return value
}

function recognised(argv: string[], declared: Declared): Deploy | undefined {
  if (declared.kind === 'command') {
    const same = declared.argv.every((word, k) => (k === 0 ? baseName(argv[0] ?? '') === baseName(word) : argv[k] === word))
    return same ? { repo: declared.repo, env: declared.env, what: declared.argv.join(' ') } : undefined
  }
  if (declared.kind === 'script') {
    const at = [0, 1].find((k) => argv[k] !== undefined && endsWithPath(argv[k], declared.path) && (k === 0 || INTERPRETERS.test(argv[0])))
    if (at === undefined) return undefined
    const env = argv.slice(at + 1).map(envOf).find((named) => named !== undefined)
    return { repo: declared.repo, env, what: declared.path }
  }
  if (declared.kind === 'workflow') {
    if (baseName(argv[0] ?? '') !== 'gh') return undefined
    const words: string[] = []
    for (let k = 1; k < argv.length && words.length < 3; k++) {
      if (argv[k] === '-R' || argv[k] === '--repo') k++
      else if (!argv[k].startsWith('-')) words.push(argv[k])
    }
    if (words[0] !== 'workflow' || words[1] !== 'run' || words[2] === undefined) return undefined
    if (baseName(words[2]) !== baseName(declared.workflow)) return undefined
    return { repo: declared.repo, env: envOf(fieldValue(argv, declared.input)), what: 'gh workflow run ' + declared.workflow }
  }
  return undefined
}

/** The deploys the simple commands of a Bash line make, as the repositories declare them. */
export function bashDeploys(line: string, declared: Declared[]): Deploy[] {
  const out: Deploy[] = []
  for (const argv of simpleCommands(line)) {
    for (const one of declared) {
      const found = recognised(argv, one)
      if (found) out.push(found)
    }
  }
  return out
}

/** The deploys a Skill call makes, the skill named as the model writes it (`/name`, `plugin:name`). */
export function skillDeploys(skill: string, declared: Declared[]): Deploy[] {
  const name = skill.replace(/^\//, '')
  return declared.flatMap((one) => (
    one.kind === 'skill' && (name === one.name || name.endsWith(':' + one.name))
      ? [{ repo: one.repo, env: one.env, what: 'skill ' + one.name }]
      : []
  ))
}

/** The one line a deploy the list does not grant is refused with, naming how the operator adds it. */
export function deployRefusal(deploy: Deploy): string {
  if (deploy.env === undefined) {
    return 'github: ' + deploy.what + ' refused on ' + deploy.repo + ': its environment is none of ' + DEPLOY_ENVS.join(', ')
      + ' (name it in the call); the list grants a deploy per environment.'
  }
  return 'github: ' + deploy.what + ' refused: ' + deploy.repo + ' is not in the deploy list for ' + deploy.env
    + '; only the operator adds it, with mcp__github__gh auto-deploy-set {"repo": "' + deploy.repo + '", "env": "' + deploy.env
    + '", "on": true, "words": "<their recorded answer naming auto-deploy, verbatim>"}.'
}

/** The first refusal among deploys, or undefined when the list grants them all. */
export function firstRefusal(list: DeployList, deploys: Deploy[]): string | undefined {
  const refused = deploys.find((d) => d.env === undefined || !granted(list, d.repo, d.env))
  return refused ? deployRefusal(refused) : undefined
}
