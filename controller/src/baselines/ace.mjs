import { ProtocolError } from '../protocol.mjs'

// ACE playbook state follows the serial offline implementation.
export const ACE_SECTIONS = Object.freeze([
  'STRATEGIES & INSIGHTS',
  'FORMULAS & CALCULATIONS',
  'CODE SNIPPETS & TEMPLATES',
  'COMMON MISTAKES TO AVOID',
  'PROBLEM-SOLVING HEURISTICS',
  'CONTEXT CLUES & INDICATORS',
  'OTHERS',
])

const normalizeSection = (value) => value.toLowerCase().replaceAll(' ', '_').replaceAll('&', 'and')
const sectionNames = new Set(ACE_SECTIONS.map(normalizeSection))
const SLUGS = {
  financial_strategies_and_insights: 'fin',
  formulas_and_calculations: 'calc',
  code_snippets_and_templates: 'code',
  common_mistakes_to_avoid: 'err',
  problem_solving_heuristics: 'prob',
  context_clues_and_indicators: 'ctx',
  others: 'misc',
  meta_strategies: 'meta',
}
const slug = (section) => SLUGS[section] ?? (section.includes('_')
  ? section.split('_').slice(0, 5).map((word) => word[0]).join('')
  : section.slice(0, 4))

export function emptyPlaybook() {
  return { nextId: 1, bullets: [] }
}

export function validatePlaybook(state) {
  if (!state || !Number.isSafeInteger(state.nextId) || state.nextId < 1 || !Array.isArray(state.bullets)) {
    throw new ProtocolError('Invalid ACE playbook')
  }
  const ids = new Set()
  for (const bullet of state.bullets) {
    if (!bullet || typeof bullet.id !== 'string' || !/^[-a-z0-9]+-\d{5,}$/u.test(bullet.id)
        || ids.has(bullet.id) || Number(bullet.id.split('-').at(-1)) >= state.nextId
        || !sectionNames.has(bullet.section) || typeof bullet.content !== 'string'
        || !bullet.content.trim() || !['helpful', 'harmful'].every(
          (key) => Number.isSafeInteger(bullet[key]) && bullet[key] >= 0,
        )) {
      throw new ProtocolError('Invalid ACE bullet or counter')
    }
    ids.add(bullet.id)
  }
  return state
}

export function renderPlaybook(state) {
  validatePlaybook(state)
  return ACE_SECTIONS.map((section) => [
    `## ${section}`,
    ...state.bullets.filter((bullet) => bullet.section === normalizeSection(section))
      .map((bullet) => `[${bullet.id}] helpful=${bullet.helpful} harmful=${bullet.harmful} :: ${bullet.content}`),
  ].join('\n')).join('\n\n')
}

export function updateBulletCounts(state, tags, usedIds) {
  validatePlaybook(state)
  if (!Array.isArray(tags) || !Array.isArray(usedIds)) {
    throw new ProtocolError('ACE bullet tags must be arrays')
  }
  const next = structuredClone(state)
  const known = new Set(state.bullets.map((bullet) => bullet.id))
  const used = new Set(usedIds)
  const tagMap = new Map()
  for (const tag of tags) {
    const id = tag?.id ?? tag?.bullet
    if (!known.has(id) || !used.has(id) || !['helpful', 'harmful', 'neutral'].includes(tag?.tag)) {
      throw new ProtocolError('Reflector tagged an unknown/unused bullet or invalid tag')
    }
    tagMap.set(id, tag.tag)
  }
  for (const bullet of next.bullets) {
    const tag = tagMap.get(bullet.id)
    if (tag === 'helpful' || tag === 'harmful') bullet[tag] += 1
  }
  return validatePlaybook(next)
}

export function applyCuratorOperations(state, operations) {
  validatePlaybook(state)
  if (!Array.isArray(operations)) throw new ProtocolError('ACE operations must be an array')
  const next = structuredClone(state)
  for (const operation of operations) {
    if (operation?.type !== 'ADD' || typeof operation.content !== 'string'
        || !operation.content.trim() || (operation.section !== undefined
          && typeof operation.section !== 'string')) {
      throw new ProtocolError('The ACE serial Curator supports ADD only')
    }
    let section = normalizeSection(operation.section ?? 'general')
    if (!sectionNames.has(section) && section !== 'general') section = 'others'
    next.bullets.push({
      id: `${slug(section)}-${String(next.nextId++).padStart(5, '0')}`,
      section: section === 'general' ? 'others' : section,
      content: operation.content,
      helpful: 0,
      harmful: 0,
    })
  }
  return validatePlaybook(next)
}

export function usedBulletIds(trace, state) {
  const known = new Set(state.bullets.map((bullet) => bullet.id))
  const responses = trace.split(/\r?\n/u).filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'model' && typeof event.content === 'string')
    .map((event) => event.content).join('\n')
  return [...new Set([...responses.matchAll(/\[([-a-z0-9]+-\d{5,})\]/gu)]
    .map((match) => match[1]).filter((id) => known.has(id)))]
}

export async function trainAceSample({ state, generate, reflect, curate, maximumReflectionRounds = 3 }) {
  if (!Number.isSafeInteger(maximumReflectionRounds) || maximumReflectionRounds < 1) {
    throw new ProtocolError('ACE requires at least one reflection round')
  }
  let playbook = structuredClone(validatePlaybook(state))
  let generated = await generate({ state: playbook, reflection: null, phase: 'initial' })
  const initial = generated
  const reflections = []
  const rounds = generated.correct ? 1 : maximumReflectionRounds
  for (let round = 0; round < rounds; round += 1) {
    const wasCorrect = generated.correct
    const reflection = await reflect({ state: playbook, generated, round })
    playbook = updateBulletCounts(playbook, reflection.bullet_tags, generated.bulletIds)
    reflections.push(reflection)
    if (wasCorrect) break
    generated = await generate({ state: playbook, reflection, phase: `retry-${round + 1}` })
    if (generated.correct) break
  }
  const delta = await curate({
    state: playbook,
    reflection: reflections.at(-1),
    generated,
  })
  playbook = applyCuratorOperations(playbook, delta.operations)
  const post = await generate({ state: playbook, reflection: null, phase: 'post-curate' })
  return { state: playbook, initial, post, reflections, delta }
}
