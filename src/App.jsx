import { useMemo, useRef, useState } from 'react'
import './App.css'

const TOTAL_NUMBERS = 75
const MIN_ROUND_LIMIT = 35
const MAX_ROUND_LIMIT = 48
const DEFAULT_ROUND_LIMIT = 40

// B-I-N-G-O column ranges, standard 75-ball layout
const COLUMNS = [
  { letter: 'B', min: 1, max: 15 },
  { letter: 'I', min: 16, max: 30 },
  { letter: 'N', min: 31, max: 45 },
  { letter: 'G', min: 46, max: 60 },
  { letter: 'O', min: 61, max: 75 },
]

// How much each prior "call" boosts a number's chance of being picked.
// count=0 -> weight 1, count=1 (1x) -> 3, count=2 (2x) -> 5, count=3 (3x) -> 7, count=4 (4x) -> 9 ...
const HOT_NUMBER_BOOST = 2

// Winning patterns a generated/saved card can be checked against.
// Each predicate receives (row, col) in a 5x5 grid (col: 0=B ... 4=O, row: 0-4)
// and returns true if that cell belongs to the pattern.
const PATTERNS = {
  none: { label: 'None', test: null },
  x: { label: 'X Pattern', test: (row, col) => row === col || row + col === 4 },
  t: { label: 'T Pattern', test: (row, col) => row === 0 || col === 2 },
  lines2: { label: '2 Lines', test: (row) => row === 0 || row === 1 },
  lines3: { label: '3 Lines', test: (row) => row === 0 || row === 1 || row === 2 },
  custom: { label: 'Custom', test: null }, // shape comes from customPatternMap, built in the editor
}

const ROWS = [0, 1, 2, 3, 4]
const COLS = [0, 1, 2, 3, 4]
// Baseline top tier when no numbers have been drawn much yet. The real top of
// the cycle grows past this once a number has actually been called more times
// than this, so the editor always reaches "however many times it's been drawn".
const BASE_TOP_TIER = 6
// Color scale used for both the editor cells and the on-card badges. Ramps
// from a cool blue (1x) to hot red, saturating fully by tier 10+ so it stays
// readable even if a number's real call count keeps climbing.
const TIER_COLOR_CAP = 10
function tierColor(tier) {
  const t = Math.min(Math.max(tier, 1), TIER_COLOR_CAP)
  const ratio = (t - 1) / (TIER_COLOR_CAP - 1)
  const hue = 230 - ratio * 230
  const light = 62 - ratio * 14
  return `hsl(${hue}, 72%, ${light}%)`
}
// Cycle order for tapping a cell in the custom-pattern editor: off -> topX -> ... -> 1x -> off.
// `topTier` is the highest real call count seen so far (min BASE_TOP_TIER) so the
// editor can always target "however many times this number has actually been drawn".
function getTierCycle(topTier) {
  const top = Math.max(BASE_TOP_TIER, topTier)
  return Array.from({ length: top }, (_, i) => top - i)
}

function getStatus(n, calledThisRound, previousRounds) {
  if (calledThisRound.has(n)) return 'called'
  if (previousRounds.has(n)) return 'previous'
  return 'not-called'
}

function weightOf(n, callCounts) {
  return 1 + (callCounts[n] || 0) * HOT_NUMBER_BOOST
}

// Weighted pick of `count` unique numbers out of `pool`, biased toward numbers
// with higher callCounts (more "x"s on their circle). Does not mutate `pool`.
function weightedPickFromPool(pool, count, callCounts) {
  const remaining = [...pool]
  const chosen = []

  for (let i = 0; i < count; i++) {
    const total = remaining.reduce((sum, n) => sum + weightOf(n, callCounts), 0)
    let r = Math.random() * total
    let pickIndex = remaining.length - 1
    for (let j = 0; j < remaining.length; j++) {
      r -= weightOf(remaining[j], callCounts)
      if (r <= 0) {
        pickIndex = j
        break
      }
    }
    chosen.push(remaining[pickIndex])
    remaining.splice(pickIndex, 1)
  }

  return chosen
}

// For the currently selected pattern, figure out which (row, col) cells should
// get a hot-number placed automatically when generating cards, and at what tier.
// Custom patterns use whatever tiers were tapped in on the editor; the built-in
// X / T / Lines patterns just aim for the hottest number actually on the board
// right now (whatever the current top real call count is).
function computeTargetTierGrid(patternKey, patternTestFn, customMap, presetTier) {
  const grid = {}
  if (!patternTestFn) return grid
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      if (row === 2 && col === 2) continue // FREE space, never targeted
      if (!patternTestFn(row, col)) continue
      if (patternKey === 'custom') {
        const tier = customMap[`${row}-${col}`]
        if (tier) grid[`${row}-${col}`] = tier
      } else {
        grid[`${row}-${col}`] = presetTier
      }
    }
  }
  return grid
}


function generateBingoCard(callCounts, id, targetTierGrid = {}) {
  const columns = COLUMNS.map((col, colIndex) => {
    const isNCol = col.letter === 'N'
    const rowsNeeded = isNCol ? [0, 1, 3, 4] : [0, 1, 2, 3, 4]

    // Rows in this column that the pattern wants filled with a hot number,
    // sorted hottest-target-first so they get first pick of matching numbers.
    const targetsForColumn = rowsNeeded
      .map((row) => ({ row, tier: targetTierGrid[`${row}-${colIndex}`] }))
      .filter((t) => t.tier)
      .sort((a, b) => b.tier - a.tier)

    let pool = []
    for (let i = col.min; i <= col.max; i++) pool.push(i)

    const assignedByRow = {}
    targetsForColumn.forEach(({ row, tier }) => {
      // Prefer a number that has been called EXACTLY this many times, so it
      // lands squarely on the matching Nx cell (6x number -> 6X cell, etc).
      let candidates = pool.filter((n) => (callCounts[n] || 0) === tier)
      if (candidates.length === 0) {
        // Next best: anything called at least this many times.
        candidates = pool.filter((n) => (callCounts[n] || 0) >= tier)
      }
      if (candidates.length === 0) {
        // Last resort: whatever is hottest available in this column.
        const maxCount = Math.max(...pool.map((n) => callCounts[n] || 0))
        candidates = pool.filter((n) => (callCounts[n] || 0) === maxCount)
      }
      const [picked] = weightedPickFromPool(candidates, 1, callCounts)
      assignedByRow[row] = picked
      pool = pool.filter((n) => n !== picked)
    })

    const targetRowSet = new Set(targetsForColumn.map((t) => t.row))
    const remainingRows = rowsNeeded.filter((row) => !targetRowSet.has(row))
    const remainingValues = weightedPickFromPool(pool, remainingRows.length, callCounts).sort(
      (a, b) => a - b
    )
    remainingRows.forEach((row, i) => {
      assignedByRow[row] = remainingValues[i]
    })

    const numbers = [0, 1, 2, 3, 4].map((row) => (isNCol && row === 2 ? 'FREE' : assignedByRow[row]))
    return { letter: col.letter, numbers }
  })
  return { id, columns }
}

// A fresh, empty tracking state for one profile/caller.
function createProfileState() {
  return {
    calledThisRound: new Set(),
    previousRounds: new Set(),
    callCounts: {},
    lastCalled: null,
    round: 1,
    roundLimit: DEFAULT_ROUND_LIMIT,
  }
}

export default function App() {
  const [profiles, setProfiles] = useState(() => ({ Mike: createProfileState() }))
  const [activeProfile, setActiveProfile] = useState('Mike')
  const [newProfileName, setNewProfileName] = useState('')
  const activeState = profiles[activeProfile]
  const { calledThisRound, previousRounds, callCounts, lastCalled, round, roundLimit } = activeState
  const [inputValue, setInputValue] = useState('')
  const [savedCards, setSavedCards] = useState([])
  const [generatedCards, setGeneratedCards] = useState([])
  const [cardsToGenerate, setCardsToGenerate] = useState(1)
  const [pattern, setPattern] = useState('none')
  const [customPatternMap, setCustomPatternMap] = useState({}) // `${row}-${col}` -> 4 | 3 | 2
  const [activePanel, setActivePanel] = useState('generator') // 'generator' | 'saved'
  const [shake, setShake] = useState(false)
  const [limitMessage, setLimitMessage] = useState('')
  const nextCardIdRef = useRef(1)

  const numbers = useMemo(
    () => Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1),
    []
  )

  const roundFull = calledThisRound.size >= roundLimit

  // Applies a partial-or-functional update to only the currently active
  // profile's tracking state, leaving every other profile's history untouched.
  const updateActiveProfile = (updater) => {
    setProfiles((prev) => {
      const current = prev[activeProfile]
      const patch = typeof updater === 'function' ? updater(current) : updater
      return { ...prev, [activeProfile]: { ...current, ...patch } }
    })
  }

  const profileNames = Object.keys(profiles)

  const addProfile = () => {
    const name = newProfileName.trim()
    if (!name) return
    setProfiles((prev) => (prev[name] ? prev : { ...prev, [name]: createProfileState() }))
    setActiveProfile(name)
    setNewProfileName('')
  }

  const switchProfile = (name) => {
    setActiveProfile(name)
  }

  const removeProfile = (name) => {
    if (profileNames.length <= 1) return
    setProfiles((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    if (activeProfile === name) {
      setActiveProfile(profileNames.find((n) => n !== name))
    }
  }

  // Highest number of times any single number has actually been drawn so far.
  // Drives how far the custom-pattern tier cycle (and hottest-target for preset
  // patterns) extends — it always reaches "however many times it's been drawn".
  const maxCallCount = useMemo(() => {
    const counts = Object.values(callCounts)
    return counts.length ? Math.max(...counts) : 0
  }, [callCounts])

  const tierCycle = useMemo(() => getTierCycle(maxCallCount), [maxCallCount])

  const patternTest = useMemo(() => {
    if (pattern === 'custom') {
      return (row, col) => customPatternMap[`${row}-${col}`] !== undefined
    }
    return PATTERNS[pattern]?.test || null
  }, [pattern, customPatternMap])

  const toggleCustomCell = (row, col) => {
    const key = `${row}-${col}`
    setCustomPatternMap((prev) => {
      const next = { ...prev }
      const current = next[key]
      const idx = tierCycle.indexOf(current)
      if (idx === -1) {
        next[key] = tierCycle[0]
      } else if (idx === tierCycle.length - 1) {
        delete next[key]
      } else {
        next[key] = tierCycle[idx + 1]
      }
      return next
    })
  }

  const callNumber = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > TOTAL_NUMBERS) {
      setShake(true)
      setTimeout(() => setShake(false), 400)
      return
    }
    if (calledThisRound.has(n)) {
      updateActiveProfile({ lastCalled: n })
      return
    }
    if (roundFull) {
      setLimitMessage(`Round limit reached (${roundLimit}/${roundLimit}). Start a new round to continue.`)
      setTimeout(() => setLimitMessage(''), 2200)
      return
    }
    updateActiveProfile((prev) => ({
      calledThisRound: new Set(prev.calledThisRound).add(n),
      callCounts: { ...prev.callCounts, [n]: (prev.callCounts[n] || 0) + 1 },
      lastCalled: n,
    }))
  }

  const handleHighlight = () => {
    const n = parseInt(inputValue, 10)
    callNumber(n)
    setInputValue('')
  }

  // Removes a mistakenly-entered number: un-calls it from whichever set it's
  // currently sitting in (this round or an earlier one) and rolls back its
  // call count by one, so hot/cold tracking stays accurate.
  const uncallNumber = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > TOTAL_NUMBERS) {
      setShake(true)
      setTimeout(() => setShake(false), 400)
      return
    }
    if (calledThisRound.has(n)) {
      updateActiveProfile((prev) => {
        const nextCalled = new Set(prev.calledThisRound)
        nextCalled.delete(n)
        const nextCounts = { ...prev.callCounts }
        if (nextCounts[n] > 1) nextCounts[n] -= 1
        else delete nextCounts[n]
        return {
          calledThisRound: nextCalled,
          callCounts: nextCounts,
          lastCalled: prev.lastCalled === n ? null : prev.lastCalled,
        }
      })
    } else if (previousRounds.has(n)) {
      updateActiveProfile((prev) => {
        const nextPrevious = new Set(prev.previousRounds)
        nextPrevious.delete(n)
        const nextCounts = { ...prev.callCounts }
        if (nextCounts[n] > 1) nextCounts[n] -= 1
        else delete nextCounts[n]
        return { previousRounds: nextPrevious, callCounts: nextCounts }
      })
    } else {
      setLimitMessage(`${n} hasn't been called, so there's nothing to undo.`)
      setTimeout(() => setLimitMessage(''), 2200)
    }
  }

  const handleUndo = () => {
    const n = parseInt(inputValue, 10)
    uncallNumber(n)
    setInputValue('')
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleHighlight()
  }

  // Clicking a ball toggles it: tap an uncalled number to call it, tap an
  // already-called-this-round number to undo it (e.g. you typed it in wrong).
  const toggleNumber = (n) => {
    if (calledThisRound.has(n)) {
      uncallNumber(n)
    } else {
      callNumber(n)
    }
  }

  const startNewRound = () => {
    updateActiveProfile((prev) => {
      const nextPrevious = new Set(prev.previousRounds)
      prev.calledThisRound.forEach((n) => nextPrevious.add(n))
      return {
        previousRounds: nextPrevious,
        calledThisRound: new Set(),
        lastCalled: null,
        round: prev.round + 1,
      }
    })
  }

  const handleRoundLimitChange = (e) => {
    const val = parseInt(e.target.value, 10)
    updateActiveProfile({ roundLimit: Math.min(MAX_ROUND_LIMIT, Math.max(MIN_ROUND_LIMIT, val)) })
  }

  const handleGenerateCards = () => {
    const count = Math.min(6, Math.max(1, cardsToGenerate))
    const presetTier = Math.max(maxCallCount, 1)
    const targetTierGrid = computeTargetTierGrid(pattern, patternTest, customPatternMap, presetTier)
    const fresh = Array.from({ length: count }, () => {
      const card = generateBingoCard(callCounts, nextCardIdRef.current, targetTierGrid)
      nextCardIdRef.current += 1
      return card
    })
    setGeneratedCards(fresh)
    setActivePanel('generator')
  }

  const handleSaveCard = (card) => {
    setSavedCards((prev) => [...prev, card])
  }

  const handleRemoveSavedCard = (id) => {
    setSavedCards((prev) => prev.filter((c) => c.id !== id))
  }

  return (
    <div className="page">
      <div className="card">
        <div className="card-top">
          <h1 className="title">
            <span className="title-icon" aria-hidden="true">
              🎯
            </span>
            Called Numbers <span className="round-label">(Round {round})</span>
          </h1>

          <div className="legend">
            <span className="legend-item">
              <span className="swatch swatch-called" />
              Called this round
            </span>
            <span className="legend-item">
              <span className="swatch swatch-previous" />
              Previous rounds
            </span>
            <span className="legend-item">
              <span className="swatch swatch-not-called" />
              Not called
            </span>
          </div>
        </div>

        <div className="profile-bar">
          <span className="profile-label">Profile:</span>
          <div className="profile-pills">
            {profileNames.map((name) => (
              <button
                key={name}
                className={`profile-pill ${name === activeProfile ? 'profile-pill-active' : ''}`}
                onClick={() => switchProfile(name)}
                title={`Switch to ${name} — their called numbers are kept separately`}
              >
                {name}
                {profileNames.length > 1 && (
                  <span
                    className="profile-remove"
                    role="button"
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeProfile(name)
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
          </div>
          <input
            className="profile-name-input"
            type="text"
            placeholder="New profile name"
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addProfile()
            }}
          />
          <button className="profile-add-btn" onClick={addProfile}>
            + Add profile
          </button>
        </div>

        <div className="controls">
          <input
            className={`number-input ${shake ? 'shake' : ''}`}
            type="number"
            min={1}
            max={75}
            placeholder="Enter number (1-75)"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="highlight-btn" onClick={handleHighlight} disabled={roundFull}>
            Highlight
          </button>
          <button className="undo-btn" onClick={handleUndo}>
            Undo
          </button>

          <div className="round-limit">
            <label htmlFor="round-limit-input">Per-round limit</label>
            <input
              id="round-limit-input"
              type="range"
              min={MIN_ROUND_LIMIT}
              max={MAX_ROUND_LIMIT}
              value={roundLimit}
              onChange={handleRoundLimitChange}
            />
            <span className="round-limit-value">{roundLimit}</span>
          </div>

          <div className="round-progress">
            <span className={roundFull ? 'progress-full' : ''}>
              {calledThisRound.size} / {roundLimit} called
            </span>
            <button className="new-round-btn" onClick={startNewRound}>
              New round
            </button>
          </div>
        </div>

        {limitMessage && <div className="limit-toast">{limitMessage}</div>}

        <div className="grid">
          {numbers.map((n) => {
            const status = getStatus(n, calledThisRound, previousRounds)
            const isActive = n === lastCalled && status === 'called'
            const count = callCounts[n] || 0
            return (
              <button
                key={n}
                className={`ball ball-${status} ${isActive ? 'ball-active' : ''}`}
                onClick={() => toggleNumber(n)}
                title={`Number ${n}${count > 0 ? ` — called ${count}x` : ''}${status === 'called' ? ' (tap to undo)' : ''}`}
              >
                {status !== 'not-called' && <span className="star">★</span>}
                <span className="ball-number">{n}</span>
                {count > 0 && <span className="count-badge">{count}x</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="card generator-card">
        <div className="generator-header">
          <h2 className="generator-title">
            <span className="title-icon" aria-hidden="true">
              🎲
            </span>
            Card Generator
          </h2>
          <p className="generator-subtitle">
            Numbers with a higher call count (<strong>2x</strong>, <strong>3x</strong>,{' '}
            <strong>4x</strong>…) are weighted to appear more often on generated cards. Pick a
            win pattern and the generator will automatically slot hot numbers into that
            pattern's cells first.
          </p>
        </div>

        <div className="generator-controls">
          <label htmlFor="card-count-input" className="generator-label">
            Cards to generate
          </label>
          <input
            id="card-count-input"
            type="number"
            min={1}
            max={6}
            value={cardsToGenerate}
            onChange={(e) => setCardsToGenerate(parseInt(e.target.value, 10) || 1)}
            className="card-count-input"
          />
          <button className="highlight-btn" onClick={handleGenerateCards}>
            Generate Cards
          </button>

          <div className="pattern-picker">
            <span className="generator-label">Win pattern</span>
            <div className="pattern-options">
              {Object.entries(PATTERNS).map(([key, def]) => (
                <button
                  key={key}
                  className={`pattern-btn ${pattern === key ? 'pattern-btn-active' : ''}`}
                  onClick={() => setPattern(key)}
                  type="button"
                >
                  {def.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {pattern === 'custom' ? (
          <div className="custom-editor-row">
            <div className="custom-pattern-editor">
              <div className="custom-editor-call-row">
                <input
                  className={`number-input ${shake ? 'shake' : ''}`}
                  type="number"
                  min={1}
                  max={75}
                  placeholder="Enter number (1-75)"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <button className="highlight-btn" onClick={handleHighlight} disabled={roundFull}>
                  Highlight
                </button>
                <button className="undo-btn" onClick={handleUndo}>
                  Undo
                </button>
              </div>
              <p className="custom-pattern-hint">
                Tap a cell to place where hot numbers should land: {tierCycle.map((t) => `${t}X`).join(' → ')} →
                off. Tiers track how many times a number has actually been drawn, so this
                grows past {BASE_TOP_TIER}X once one has. Any tapped cell becomes part of the pattern.
              </p>
              <div className="pattern-preview-grid">
                {ROWS.map((row) =>
                  COLS.map((col) => {
                    const isFreeCell = row === 2 && col === 2
                    const tier = customPatternMap[`${row}-${col}`]
                    return (
                      <button
                        key={`${row}-${col}`}
                        type="button"
                        style={tier ? { background: tierColor(tier) } : undefined}
                        className={`pattern-preview-cell ${
                          isFreeCell ? 'pattern-preview-cell-free' : ''
                        }`}
                        onClick={() => !isFreeCell && toggleCustomCell(row, col)}
                        disabled={isFreeCell}
                        title={isFreeCell ? 'FREE space — always hit, no tier needed' : undefined}
                      >
                        {isFreeCell ? '★' : tier ? `${tier}X` : ''}
                      </button>
                    )
                  })
                )}
              </div>
            </div>

            {generatedCards.length > 0 && activePanel === 'generator' && (
              <div className="bingo-cards-grid custom-cards-grid">
                {generatedCards.map((card) => (
                  <BingoCard
                    key={card.id}
                    card={card}
                    calledThisRound={calledThisRound}
                    previousRounds={previousRounds}
                    patternTest={patternTest}
                    patternLabel={PATTERNS[pattern].label}
                    callCounts={callCounts}
                    onSave={() => handleSaveCard(card)}
                    isSaved={savedCards.some((c) => c.id === card.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          generatedCards.length > 0 &&
          activePanel === 'generator' && (
            <div className="bingo-cards-grid">
              {generatedCards.map((card) => (
                <BingoCard
                  key={card.id}
                  card={card}
                  calledThisRound={calledThisRound}
                  previousRounds={previousRounds}
                  patternTest={patternTest}
                  patternLabel={PATTERNS[pattern].label}
                  callCounts={callCounts}
                  onSave={() => handleSaveCard(card)}
                  isSaved={savedCards.some((c) => c.id === card.id)}
                />
              ))}
            </div>
          )
        )}

        {activePanel === 'saved' && (
          <div className="bingo-cards-grid">
            {savedCards.length === 0 && (
              <p className="empty-state">No saved cards yet — generate one and hit “Save”.</p>
            )}
            {savedCards.map((card) => (
              <BingoCard
                key={card.id}
                card={card}
                calledThisRound={calledThisRound}
                previousRounds={previousRounds}
                patternTest={patternTest}
                patternLabel={PATTERNS[pattern].label}
                callCounts={callCounts}
                onRemove={() => handleRemoveSavedCard(card.id)}
                isSaved
              />
            ))}
          </div>
        )}
      </div>

      <div className="bottom-bar">
        <button
          className={`pill pill-primary ${activePanel === 'saved' ? 'pill-active' : ''}`}
          onClick={() => setActivePanel('saved')}
        >
          <span className="pill-icon" aria-hidden="true">
            🎯
          </span>
          My Cards
          <span className="pill-count pill-count-light">{savedCards.length}</span>
        </button>
        <button
          className={`pill pill-secondary ${activePanel === 'generator' ? 'pill-active' : ''}`}
          onClick={() => setActivePanel('generator')}
        >
          <span className="pill-icon" aria-hidden="true">
            🎫
          </span>
          Generated
          <span className="pill-count pill-count-dark">{generatedCards.length}</span>
        </button>
      </div>
    </div>
  )
}

function BingoCard({
  card,
  calledThisRound,
  previousRounds,
  patternTest = null,
  patternLabel = 'None',
  callCounts = {},
  onSave,
  onRemove,
  isSaved,
}) {
  const rows = [0, 1, 2, 3, 4]

  // Determine hit state for every cell up front so we can also check for a win.
  const cells = rows.map((row) =>
    card.columns.map((col, colIndex) => {
      const value = col.numbers[row]
      const isFree = value === 'FREE'
      const isHit = isFree || calledThisRound.has(value) || previousRounds.has(value)
      const isPatternCell = patternTest ? patternTest(row, colIndex) : false
      const count = isFree ? 0 : callCounts[value] || 0
      return { row, col: colIndex, value, isFree, isHit, isPatternCell, count }
    })
  )

  const hasWin =
    patternTest && cells.flat().filter((c) => c.isPatternCell).every((c) => c.isHit)

  return (
    <div className={`bingo-card ${hasWin ? 'bingo-card-win' : ''}`}>
      {hasWin && <div className="bingo-win-badge">BINGO! {patternLabel}</div>}
      <div className="bingo-card-header">
        {card.columns.map((col) => (
          <span key={col.letter} className={`bingo-card-letter letter-${col.letter}`}>
            {col.letter}
          </span>
        ))}
      </div>
      <div className="bingo-card-body">
        {cells.map((row) =>
          row.map(({ col, value, isFree, isHit, isPatternCell, count }) => (
            <div
              key={`${card.columns[col].letter}-${value}-${col}`}
              className={`bingo-cell ${isFree ? 'bingo-cell-free' : ''} ${
                isHit && !isFree ? 'bingo-cell-hit' : ''
              } ${isPatternCell ? 'bingo-cell-pattern' : ''}`}
            >
              <span className="bingo-cell-value">{isFree ? '★' : value}</span>
              {isPatternCell && count > 0 && (
                <span className="pattern-multiplier-badge" style={{ background: tierColor(count) }}>
                  {count}X
                </span>
              )}
            </div>
          ))
        )}
      </div>
      <div className="bingo-card-footer">
        {onSave && (
          <button className="card-action-btn" onClick={onSave} disabled={isSaved}>
            {isSaved ? 'Saved ✓' : 'Save to My Cards'}
          </button>
        )}
        {onRemove && (
          <button className="card-action-btn card-action-remove" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </div>
  )
}
