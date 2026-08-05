import { MOMENTUM_KEY_MAP } from './value-bag.js';
import { PageInstance, Zone } from './page-instance.js';
import { Location } from './location.js';

// Value routing: PageInstances that represent an active superstar
// (page.player is set) route momentum/HP keys to the real subsystems;
// everything else (and every other key) uses the generic per-instance
// bag. This is the bridge between the Lisp-DSL's flat key/value view of
// the world and our actual typed model.
function routedGet(obj, key) {
  if (obj && obj.player) {
    if (key in MOMENTUM_KEY_MAP) return obj.player.momentum.get(MOMENTUM_KEY_MAP[key]);
    if (key === 'Hit_Points') return obj.player.hitPoints;
  }
  if (obj && typeof obj.getValue === 'function') return obj.getValue(key);
  return 0;
}

function routedSet(obj, key, value, game) {
  if (obj && obj.player) {
    if (key in MOMENTUM_KEY_MAP) {
      const before = obj.player.momentum.values[MOMENTUM_KEY_MAP[key]];
      obj.player.momentum.values[MOMENTUM_KEY_MAP[key]] = value;
      if (game) game.log(`[WASetValue] ${obj.player.id} ${key}: ${before} -> ${value}`);
      return value;
    }
    if (key === 'Hit_Points') {
      const before = obj.player.hitPoints;
      obj.player.hitPoints = value;
      if (game) game.log(`[WASetValue] ${obj.player.id} Hit_Points: ${before} -> ${value} (DIRECT SET, not via WADamage/WAHeal)`);
      return value;
    }
  }
  if (obj && typeof obj.setValue === 'function') obj.setValue(key, value);
  return value;
}

function routedAdd(obj, key, amount, game) {
  const cur = routedGet(obj, key);
  return routedSet(obj, key, cur + amount, game);
}

function playerOf(game, x) {
  // Accepts a Player, a PageInstance with .player, or a player-id string.
  if (!x) return null;
  if (typeof x === 'string') return game.players[x];
  if (x.player) return x.player;
  if (x.momentum) return x; // already a Player
  return null;
}

// Card-type classification, by FIELD CONTENT rather than template
// filename. CORRECTED (2024-08): template-name matching (e.g.
// "startsWith('Moves_Template')") silently excluded a large chunk of
// real cards, because move templates vary a lot across the 7 expansion
// sets: Moves_Template*, Moves_Long_Text_Template*, BN-Moves_Template*,
// and even the one-off "Move_2.gag". This was causing real move cards
// (confirmed: Throw Over The Ropes, Clothesline Over The Ropes, Back
// Body Drop to Ringside) to never be selectable by the AI at all --
// which meant count-out, and several DQ/pin-adjacent lines of play,
// could never be reached. Field presence is far more consistent: only
// move cards carry a "Method" field (Strike/Strength/Technical/Agility/
// Knowledge); only basic momentum cards carry a "{Type}_Points" field.
export function isMoveCard(def) {
  if (!def) return false;
  if (def.fields.Method) return true;
  const t = def.template || '';
  return t.includes('Moves') || t === 'Move_2.gag';
}

export function isMomentumCard(def) {
  if (!def) return false;
  return ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']
    .some((type) => def.fields[`${type}_Points`] !== undefined)
    || (def.template || '').replace('-', '_').startsWith('Momentum_Template');
}

function asName(x) {
  if (x === false || x === undefined || x === null) return '';
  if (typeof x === 'object' && 'name' in x) return x.name;
  return String(x);
}

export function buildHostFunctions(game) {
  const H = {};

  // ---- Generic value bag -------------------------------------------------
  H.WAGetValue = (i, ctx, env, [obj, keyNode]) => routedGet(obj, keyArg(keyNode));
  H.WASetValue = (i, ctx, env, [obj, keyNode, value]) => routedSet(obj, keyArg(keyNode), value, game);
  H.WAAddValue = (i, ctx, env, [obj, keyNode, amount]) => routedAdd(obj, keyArg(keyNode), amount, game);
  H.WARemoveValue = (i, ctx, env, [obj, keyNode]) => {
    if (obj && typeof obj.removeValue === 'function') obj.removeValue(keyArg(keyNode));
    return false;
  };
  H.WAHasValue = (i, ctx, env, [obj, keyNode]) => {
    if (obj && typeof obj.hasValue === 'function') return obj.hasValue(keyArg(keyNode));
    return false;
  };

  // Keys arrive already evaluated as strings (bare symbols evaluate to
  // their own name per the interpreter's `sym` fallback) -- normalize.
  function keyArg(v) {
    return typeof v === 'string' ? v : String(v);
  }

  // ---- Identity / ownership ----------------------------------------------
  H.WAGetName = (i, ctx, env, [obj]) => asName(obj);
  H.WAGetNAme = H.WAGetName; // confirmed typo variant appears in real data
  H.WAmessage = (i, ctx, env, args) => H.WAMessage(i, ctx, env, args); // case variant
  H.WAGetUNID = (i, ctx, env, [obj]) => (obj && obj.def ? unidFor(obj.def) : (obj && unidFor(obj)) || 0);
  H.WAGetBaseUNID = H.WAGetUNID; // TODO-CONFIRM: distinct from UNID for variant printings; treated the same for now
  H.WAGetNameByUNID = (i, ctx, env, [unid]) => {
    const def = game.cardDb.getByUNID(unid);
    return def ? def.name : '';
  };
  function unidFor(def) {
    for (const [unid, d] of game.cardDb.byUNID) if (d === def) return unid;
    return 0;
  }

  H.WAGetOwner = (i, ctx, env, [obj]) => obj?.ownerId ?? (obj?.id ?? false);
  H.WAGetPlayedBy = (i, ctx, env, [obj]) => obj?.playedByPlayerId ?? obj?.ownerId ?? false;
  H.WAGetPlayedOn = (i, ctx, env, [obj]) => obj?.playedOnTurn ?? -1;
  H.WAGetTurnPlayedOn = H.WAGetPlayedOn;
  H.WABelongsTo = (i, ctx, env, [obj, playerId]) => obj?.ownerId === playerId;
  H.WAGetOpponent = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    if (!p) return false;
    return game.opponentOf(p.id).superstarPage;
  };
  H.WAGetActiveSuperstar = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    return p ? p.superstarPage : false;
  };
  H.WAGetPlayers = () => ['A', 'B'];
  H.WAGetSuperstars = (i, ctx, env, [playerId]) => {
    const p = game.players[playerId];
    return p ? [p.superstarPage] : []; // single-superstar (1v1) for now
  };
  H.WAGetAllSuperstars = () => [game.players.A.superstarPage, game.players.B.superstarPage];
  H.WAIsHuman = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    return p ? !!p.isHuman : false;
  };
  H.WAIsSuperstar = (i, ctx, env, [obj]) => obj instanceof PageInstance && !!obj.player;

  // ---- Hand / playbook -----------------------------------------------------
  H.WAGetHand = (i, ctx, env, [x]) => (playerOf(game, x)?.playbook.hand) || [];
  H.WAGetHandCount = (i, ctx, env, [x]) => (playerOf(game, x)?.playbook.hand.length) || 0;
  H.WAGetPlaybook = (i, ctx, env, [x]) => (playerOf(game, x)?.playbook.library) || [];
  H.WAEnumPlaybook = H.WAGetPlaybook;
  H.WAInHand = (i, ctx, env, [x, page]) => (playerOf(game, x)?.playbook.hand.includes(page)) || false;
  H.WADrawPage = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    if (!p) return 0;
    const drawn = p.playbook.draw(1);
    if (drawn.length === 0) return 0;
    return drawn[0];
  };
  H.WADrawPageByUNID = (i, ctx, env, [x, unid]) => {
    const p = playerOf(game, x);
    if (!p) return 0;
    const idx = p.playbook.library.findIndex((pg) => unidFor(pg.def) === unid);
    if (idx === -1) return 0;
    const [card] = p.playbook.library.splice(idx, 1);
    p.playbook.hand.push(card);
    return card;
  };
  H.WACreatePageByUNID = (i, ctx, env, [x, unid]) => {
    const p = playerOf(game, x);
    const def = game.cardDb.getByUNID(unid);
    if (!p || !def) return 0;
    const inst = new PageInstance(def, p.id);
    inst.zone = Zone.HAND;
    p.playbook.hand.push(inst);
    return inst;
  };
  H.WACreatePage = H.WACreatePageByUNID; // TODO-CONFIRM: exact signature difference unclear
  H.WADitchFromPlaybook = (i, ctx, env, [x, page]) => {
    const p = playerOf(game, x);
    if (!p) return false;
    const idx = p.playbook.library.indexOf(page);
    if (idx !== -1) {
      p.playbook.library.splice(idx, 1);
      p.playbook.discard.push(page);
    }
    return true;
  };
  H.WADitchPage = (i, ctx, env, [page]) => {
    const p = game.players[page?.ownerId];
    if (!p) return false;
    p.playbook.ditch(page);
    return true;
  };
  H.WAPutIntoHand = (i, ctx, env, [page]) => {
    const p = game.players[page?.ownerId];
    if (p && !p.playbook.hand.includes(page)) p.playbook.hand.push(page);
    return true;
  };
  H.WAPutPageInPlaybook = (i, ctx, env, [page]) => {
    const p = game.players[page?.ownerId];
    if (p) p.playbook.library.push(page);
    return true;
  };
  H.WAMovePageFromHandToPlaybook = H.WAPutPageInPlaybook;
  H.WAStealPage = (i, ctx, env, [fromX, page]) => {
    const from = playerOf(game, fromX);
    if (from) {
      const idx = from.playbook.hand.indexOf(page);
      if (idx !== -1) from.playbook.hand.splice(idx, 1);
    }
    return true;
  };

  // ---- In-play tracking ------------------------------------------------
  H.WAInPlay = (i, ctx, env, [page]) => page?.zone === Zone.IN_PLAY;
  H.WAGetInPlay = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    return p ? allInPlayFor(p.id) : allInPlay();
  };
  H.WAPagesInPlay = () => allInPlay();
  H.WAEnumAllPages = () => allInPlay();
  function allInPlay() {
    return [...allInPlayFor('A'), ...allInPlayFor('B')];
  }
  function allInPlayFor(playerId) {
    // NOTE: simplified -- a full implementation would track a dedicated
    // in-play zone list per player; for now this covers the superstar
    // page plus anything explicitly moved to IN_PLAY.
    const p = game.players[playerId];
    const out = [p.superstarPage];
    if (p.inPlayPages) out.push(...p.inPlayPages);
    return out;
  }
  H.WAOutOfPlay = (i, ctx, env, [page]) => {
    if (page) page.zone = Zone.OUT_OF_GAME;
    return true;
  };
  H.WAUNIDInPlay = (i, ctx, env, [unid]) => allInPlay().some((pg) => pg.def && unidFor(pg.def) === unid);
  H.WAPagesThisTurn = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    return (p && p.pagesPlayedThisTurn) || [];
  };
  H.WAAddToPageList = (i, ctx, env, [list, page]) => [...(Array.isArray(list) ? list : []), page];

  // ---- Messaging ------------------------------------------------------
  H.WAMessage = (i, ctx, env, args) => {
    const [recipient, ...parts] = args;
    game.log(`[msg -> ${recipient === -1 ? 'all' : asName(recipient) || recipient}] ${parts.map(asName).join(' ')}`);
    return true;
  };
  H['WAMessage-1'] = (i, ctx, env, parts) => {
    game.log(`[msg -> all] ${parts.map(asName).join(' ')}`);
    return true;
  };
  H.WAMessageFromPage = H.WAMessage;
  H.WAWarn = (i, ctx, env, [x, amount]) => {
    const p = playerOf(game, x);
    if (!p) return false;
    game.winTracker.addWarnings(p.id, p, game.other(p.id), amount);
    return true;
  };

  // ---- Stun -------------------------------------------------------------
  H.WAIsStunned = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    return p ? p.isStunned() : false;
  };
  H.WAStun = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    if (!p) return false;
    return p.applyStun();
  };

  // ---- Momentum / cost --------------------------------------------------
  H.WAGetTotalMomentum = (i, ctx, env, [x]) => (playerOf(game, x)?.momentum.total()) || 0;
  H.WAIsMomentum = (i, ctx, env, [page]) => isMomentumCard(page?.def);
  H.WACanCoverCost = (i, ctx, env, [x, page]) => {
    const p = playerOf(game, x);
    if (!p || !page?.def) return false;
    const costMap = {};
    for (const t of ['Strike', 'Strength', 'Technical', 'Agility', 'Knowledge']) {
      const c = page.def.getNumericField(`${t}_Cost`, 0);
      if (c) costMap[t] = c;
    }
    const generic = page.def.getNumericField('Momentum_Cost', 0);
    if (generic) costMap.Momentum = generic;
    return p.momentum.canCoverCost(costMap);
  };
  H.WACanPlayPage = H.WACanCoverCost; // TODO-CONFIRM: likely also checks zone/legality, simplified for now

  // ---- Modifiers / move typing -------------------------------------------
  H.WAHasModifier = (i, ctx, env, [page, tag]) => {
    const mods = page?.def?.fields?.Modifiers || '';
    return mods.split('|').map((m) => m.replace(/^\$/, '')).includes(String(tag).replace(/^\$/, ''));
  };
  H.WAIsOfType = H.WAHasModifier; // TODO-CONFIRM: distinct semantics unclear from data, aliased for now
  H.WAIsMove = (i, ctx, env, [page]) => isMoveCard(page?.def);
  H.WAIsSpecial = (i, ctx, env, [page]) => !!page?.def?.template?.includes('Special');
  H.WAIsDamageSpecial = (i, ctx, env, [page]) => H.WAIsSpecial(i, ctx, env, [page]) && !!page?.def?.fields?.Damage;
  H.WAIsSubmissionHold = (i, ctx, env, [page]) => (page?.def?.fields?.Method === 'Submission')
    || /submission/i.test(page?.def?.text || '');
  H.WAIsConnectedDamageSpecial = H.WAIsDamageSpecial;
  H.WAGetConnectedMoves = (i, ctx, env, [x]) => (playerOf(game, x)?.connectedMovesThisTurn) || [];
  H.WAGetLastConnectedMove = (i, ctx, env, [x]) => {
    const moves = playerOf(game, x)?.connectedMovesThisTurn || [];
    return moves.length ? moves[moves.length - 1] : false;
  };
  H.WAGetProposedMove = (i, ctx, env, [x]) => (playerOf(game, x)?.proposedMove) || 0;
  H.WAForceMove = (i, ctx, env, [x, move]) => {
    const p = playerOf(game, x);
    if (p) p.proposedMove = move;
    return true;
  };
  H.WAForcePage = H.WACreatePageByUNID; // TODO-CONFIRM: real semantics likely differ (forces a specific play, not just creates)

  // ---- Turn / control -----------------------------------------------------
  H.WAGetTurn = () => game.turn;
  H.WAGetTurnLimit = () => 50;
  H.WASetTurnLimit = () => true; // fixed at 50 per confirmed rule; ignore attempts to change it
  H.WAHasControl = () => game.controlPlayerId;
  H.WAChangeControl = () => {
    game.controlPlayerId = game.other(game.controlPlayerId);
    return game.controlPlayerId;
  };
  H.WATurnsSinceLastControl = () => 0; // TODO-CONFIRM: not yet tracked

  // ---- Location / count-out ----------------------------------------------
  H.WAFindLocation = (i, ctx, env, [tag]) => {
    const t = String(tag).replace(/^\$/, '');
    if (t === 'InTheRing') return Location.IN_RING;
    if (t === 'Ringside') return Location.RINGSIDE;
    return t; // unknown location tags (e.g. steel cage variants) pass through as-is
  };
  H.WAGetLocation = (i, ctx, env, [x]) => (playerOf(game, x)?.locationState.location) || Location.IN_RING;
  H.WAMove = (i, ctx, env, [x, location]) => {
    const p = playerOf(game, x);
    if (p) p.locationState.moveTo(location);
    return true;
  };
  H.WATurnsAtLocation = (i, ctx, env, [x]) => (playerOf(game, x)?.locationState.turnsAtLocation) || 0;

  // ---- On the mat / pin --------------------------------------------------
  H.WASetOnMat = (i, ctx, env, [x, value]) => {
    const p = playerOf(game, x);
    if (p) p.setOnMat(!!value && value !== 0);
    return true;
  };
  H.WAGetOnMat = (i, ctx, env, [x]) => (playerOf(game, x)?.isOnMat()) || false;
  H.WAPinSuperstar = (i, ctx, env, [attackerX, targetX]) => {
    const attacker = playerOf(game, attackerX);
    const target = playerOf(game, targetX);
    if (!attacker || !target) return false;
    if (!target.isOnMat()) {
      // Fail soft (matches the interpreter's general philosophy): a
      // script calling this before OnMat was set is a sequencing issue
      // in the caller, not something that should crash the turn.
      game.log(`WAPinSuperstar called but ${target.id} is not on the mat -- no-op.`);
      return false;
    }
    // NOTE: base pin-chance formula unconfirmed; using 0.5 placeholder
    // per win-conditions.js documentation. Reaction window (Grab The
    // Ropes / That Was Three!) is handled at the game-loop level before
    // this is even called, matching real scripts always calling
    // WAPinSuperstar directly (the interrupt happens by the interrupt
    // card's OWN script running earlier via WACanCoverCost/Can_Be_Played
    // gating, not inside this function).
    const result = game.winTracker.attemptPin(attacker.id, target, { type: 'pass' });
    return result.success;
  };
  H.WABreakPin = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    if (p) p.setOnMat(false);
    return true;
  };
  H.WAGetPinAttempts = (i, ctx, env, [x]) => (playerOf(game, x)?.pinAttempts) || 0;
  H.WAIsPinned = (i, ctx, env, [x]) => (playerOf(game, x)?.isOnMat()) || false; // TODO-CONFIRM: distinct from OnMat?
  H.WAWin = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    if (p) game.winTracker.declarePin(p.id);
    return true;
  };
  H.WADone = () => game.winTracker.isOver();

  // ---- Submission ---------------------------------------------------------
  H.WAInSubmissionHold = (i, ctx, env, [x]) => (playerOf(game, x)?.hasSubmissionApplied) || false;
  H.WAApplyingSubmissionHold = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    return !!(p && game.players[game.other(p.id)]?.submission?.activeHold?.applierId === p.id);
  };
  H.WABreakHold = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    if (p) {
      const applierId = p.submission.activeHold?.applierId;
      p.submission.activeHold = null;
      p.hasSubmissionApplied = false;
      if (applierId) {
        const applier = game.players[applierId];
        if (applier) applier.isApplyingHold = false;
      }
    }
    return true;
  };
  H.WAGetSubmissionDamage = (i, ctx, env, [x, part]) => (playerOf(game, x)?.submission.damage[part]) || 0;
  H.WAGetInHold = (i, ctx, env, [x]) => (playerOf(game, x)?.submission.activeHold) || false;

  // ---- Damage / HP --------------------------------------------------------
  H.WAGetHitPoints = (i, ctx, env, [x]) => (playerOf(game, x)?.hitPoints) ?? 0;
  H.WAGetMaxHitPoints = (i, ctx, env, [x]) => (playerOf(game, x)?.maxHitPoints) ?? 0;
  H.WADamage = (i, ctx, env, [x, amount]) => {
    const p = playerOf(game, x);
    if (!p) return false;
    const before = p.hitPoints;
    p.hitPoints = Math.max(0, p.hitPoints - amount);
    game.log(`[WADamage] ${p.id}: ${before} -> ${p.hitPoints} (-${amount})`);
    return true;
  };
  H.WAHeal = (i, ctx, env, [x, amount]) => {
    const p = playerOf(game, x);
    if (!p) return false;
    const before = p.hitPoints;
    p.hitPoints = Math.min(p.maxHitPoints, p.hitPoints + amount);
    game.log(`[WAHeal] ${p.id}: ${before} -> ${p.hitPoints} (+${amount})`);
    return true;
  };
  H.WAGetDamageApplied = () => 0; // TODO-CONFIRM: not yet tracked per-move

  // ---- Auto-counter -------------------------------------------------------
  H.WAAutoCounter = (i, ctx, env, [x]) => {
    const p = playerOf(game, x);
    if (!p) return false;
    return p.useAutoCounter((cost) => { p.playbook.hand.splice(0, cost); });
  };
  H.WAAutocounter = H.WAAutoCounter;

  // ---- Misc / cosmetic (safe no-ops or simple passthroughs) --------------
  H.WARandom = (i, ctx, env, [min, max]) => min + Math.floor(game.rng() * (max - min + 1));
  H.WAGameMap = () => game.gameMap;
  H.WAPlaySound = () => true;
  H.WAStopSound = () => true;
  H.WASubstring = (i, ctx, env, [str, start, len]) => String(str).substr(start, len);
  H.WAStringGetValue = H.WAGetValue;
  H.WAStringAddValue = H.WAAddValue;
  H.WASetPlayedSpecial = () => true;
  H.WARunIn = () => true; // TODO: interference mechanic not yet modeled
  H.WARunOut = () => true;
  H.WAPlayedFanFavorite = (i, ctx, env, [x]) => !!(playerOf(game, x)?.alignment === 'Face');
  H.WAPlayedRulebreaker = (i, ctx, env, [x]) => !!(playerOf(game, x)?.alignment === 'Heel');

  return H;
}
