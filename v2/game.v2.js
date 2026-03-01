/* =========================================================
   MAINTAINABILITY / EXTENSION HOOKS
   - Safe no-op hooks so you can add features without touching core.
   - Add your own hooks anywhere by setting:
       window.GameHooks = { afterRenderPanels(){ ... } , ... }
   ========================================================= */
if (window.__GAME_V2_LOADED__) { console.warn("game.js loaded twice"); }
else {
window.__GAME_V2_LOADED__ = true;
window.GameHooks = window.GameHooks || {};

const UI = window.UI;
function _callHook(name, ...args){
  try{
    const h = window.GameHooks && window.GameHooks[name];
    if(typeof h === "function") h(...args);
  }catch(err){
    console.warn("Hook error:", name, err);
  }
}


/* =========================================================
   STEP 1) PoE급 확장형 태그/Mod 엔진 (코어 로직 "미변경" 버전)
   - 기존 dmgMul/maxHpAdd 같은 누적 방식은 그대로 두고,
     앞으로 "모드"로 확장할 기반만 추가합니다.
   - 이 블록은 <script> 안, 전역(함수들 선언 가능한 곳)에 그대로 붙여넣기.

   ✅ 제공 기능
   1) 태그 매칭: hasTag, hasAllTags, mergeTags
   2) Mod 구조: { id, source, scope, requiresAll, requiresAny, forbids, stat, op, value, stacks, maxStacks, enabled }
   3) Mod 평가/적용: modsFor(), statFromMods()
   4) 디버그: debugModsForStat()

   ⚠️ 아직은 기존 데미지/스탯 계산을 건드리지 않습니다.
      (다음 단계에서 recalcFromGear()에 한 겹 추가)
   ========================================================= */

/** ---------------------------------------------------------
 *  태그 유틸 (가볍고 안전)
 * -------------------------------------------------------- */
function _normTag(t){ return String(t||"").trim().toLowerCase(); }

function mergeTags(...lists){
  const out = new Set();
  for(const l of lists){
    if(!l) continue;
    for(const t of l){
      const nt = _normTag(t);
      if(nt) out.add(nt);
    }
  }
  return Array.from(out);
}

function hasTag(tags, tag){
  if(!tags || !tags.length) return false;
  const nt = _normTag(tag);
  for(const t of tags){
    if(_normTag(t) === nt) return true;
  }
  return false;
}

function hasAllTags(tags, required){
  if(!required || required.length === 0) return true;
  if(!tags || tags.length === 0) return false;
  for(const r of required){
    if(!hasTag(tags, r)) return false;
  }
  return true;
}

function hasAnyTag(tags, any){
  if(!any || any.length === 0) return true; // any조건이 없으면 통과
  if(!tags || tags.length === 0) return false;
  for(const r of any){
    if(hasTag(tags, r)) return true;
  }
  return false;
}

function hasNoTags(tags, forbids){
  if(!forbids || forbids.length === 0) return true;
  if(!tags || tags.length === 0) return true;
  for(const f of forbids){
    if(hasTag(tags, f)) return false;
  }
  return true;
}

/** ---------------------------------------------------------
 *  Mod 엔진 (PoE 스타일의 최소 코어)
 * -------------------------------------------------------- */
/**
 * Mod.op (연산 타입)
 * - "add"  : flat 더하기 (예: +25 최대체력)
 * - "inc"  : 증가율 합산 (예: 20% 증가 -> 0.20)
 * - "more" : 배율 곱 (예: 30% more -> 0.30)
 *
 * 권장: value는 숫자  (inc/more는 0.20 형태)
 *
 * Mod.scope (적용 범위) - 지금은 "player"만 쓰고 확장 예정
 * - "player" | "skill" | "enemy" | "map" | "global"
 */
const MOD_OPS = Object.freeze({ add:"add", inc:"inc", more:"more" });

/**
 * 전역 모드 저장소 (아직은 코어에 연결하지 않음)
 * - equipment / buffs / map / etc에서 모드를 이곳으로 모을 예정
 */
window.GameMods = window.GameMods || {
  /** @type {Array<Mod>} */
  list: [],
  add(mod){ this.list.push(mod); return mod; },
  removeById(id){ this.list = this.list.filter(m => m.id !== id); },
  clear(){ this.list.length = 0; }
};

/**
 * Mod 매칭(태그/조건) 검사
 * @param {Mod} mod
 * @param {Object} ctx - 평가 컨텍스트
 * @param {Array<string>} ctx.tags - 현재 대상(플레이어/스킬 등)의 태그
 * @param {string} ctx.scope - "player" 등
 * @returns {boolean}
 */
function modMatches(mod, ctx){
  if(!mod) return false;
  if(mod.enabled === false) return false;

  // scope 검사 (없으면 global 취급)
  const scope = mod.scope || "global";
  if(scope !== "global" && ctx && ctx.scope && scope !== ctx.scope) return false;

  const tags = (ctx && ctx.tags) ? ctx.tags : [];

  // requiresAll: AND 조건
  if(!hasAllTags(tags, mod.requiresAll)) return false;

  // requiresAny: OR 조건
  if(!hasAnyTag(tags, mod.requiresAny)) return false;

  // forbids: 금지 태그
  if(!hasNoTags(tags, mod.forbids)) return false;

  return true;
}

/**
 * 컨텍스트에 적용 가능한 모드 목록 반환
 * @param {Object} ctx
 * @param {string} ctx.scope
 * @param {Array<string>} ctx.tags
 * @param {string=} statKey - 특정 스탯만 필터
 */
function modsFor(ctx, statKey){
  const all = (window.GameMods && window.GameMods.list) ? window.GameMods.list : [];
  const out = [];
  for(const m of all){
    if(statKey && m.stat !== statKey) continue;
    if(modMatches(m, ctx)) out.push(m);
  }
  return out;
}

/**
 * 스탯 계산 (add/inc/more 순서로)
 * @param {number} baseValue - 기존 로직이 계산한 값(혹은 기본값)
 * @param {Object} ctx - { scope, tags }
 * @param {string} statKey - 예: "max_hp", "damage"
 * @param {Object=} opt
 * @param {number=} opt.clampMin
 * @param {number=} opt.clampMax
 * @returns {number}
 */
function statFromMods(baseValue, ctx, statKey, opt){
  const list = modsFor(ctx, statKey);

  let add = 0;
  let inc = 0;     // 합산
  let moreMul = 1; // 곱

  for(const m of list){
    const stacks = Math.max(1, (m.stacks || 1));
    const maxStacks = (m.maxStacks || stacks);
    const s = Math.min(stacks, maxStacks);
    const v = (Number(m.value) || 0) * s;

    const op = m.op || MOD_OPS.add;
    if(op === MOD_OPS.add) add += v;
    else if(op === MOD_OPS.inc) inc += v;
    else if(op === MOD_OPS.more) moreMul *= (1 + v);
  }

  let out = (Number(baseValue)||0) + add;
  out *= (1 + inc);
  out *= moreMul;

  if(opt){
    if(typeof opt.clampMin === "number") out = Math.max(opt.clampMin, out);
    if(typeof opt.clampMax === "number") out = Math.min(opt.clampMax, out);
  }
  return out;
}

/** ---------------------------------------------------------
 *  디버그 도구
 * -------------------------------------------------------- */
function debugModsForStat(ctx, statKey){
  const list = modsFor(ctx, statKey);
  const rows = list.map(m => ({
    id: m.id,
    stat: m.stat,
    op: m.op,
    value: m.value,
    scope: m.scope || "global",
    source: m.source || "",
    requiresAll: (m.requiresAll||[]).join(","),
    requiresAny: (m.requiresAny||[]).join(","),
    forbids: (m.forbids||[]).join(","),
    stacks: m.stacks || 1
  }));
  console.table(rows);
  return rows;
}

/** ---------------------------------------------------------
 *  샘플 모드 (작동 확인용) - 원하면 지워도 됨
 *  - 아직 recalcFromGear()에 연결 전이라 체감은 없고,
 *    debugModsForStat()로 매칭만 확인 가능
 * -------------------------------------------------------- */
/*
window.GameMods.add({
  id:"test_melee_damage_inc",
  source:"debug",
  scope:"player",
  requiresAll:["melee"],    // 플레이어/스킬 tags에 melee가 있으면 적용
  stat:"damage",
  op:"inc",
  value:0.20
});

window.GameMods.add({
  id:"test_maxhp_add",
  source:"debug",
  scope:"player",
  requiresAll:[],
  stat:"max_hp",
  op:"add",
  value:25
});
*/


/* =========================================================
   STEP 5) 스킬/몹/맵까지 태그 확장 (PoE식 상호작용 기반)
   - 목표: '데미지 계산'과 '피해 계산'에 공통 태그 컨텍스트를 붙여,
           앞으로 "vs boss", "projectile", "fire", "map tier" 같은 모드를
           코드 수정 없이 모드만 추가해서 구현 가능하게 함.
   - 안전장치: 아래 플래그로 on/off 가능
   ========================================================= */
const USE_TAG_CONTEXTS = true;

/** ===== 태그 원천(기본값) ===== */
const PLAYER_BASE_TAGS = Object.freeze(["player","humanoid","samurai"]);
const SKILL_TAGS = Object.freeze({
  // 기본 평타(카타나)
  attack:   ["attack","melee","physical"],
  // 궁극기(광역 베기)
  ultimate: ["attack","aoe","physical","ultimate"],
  // 활(원거리)
  arrow:    ["attack","projectile","physical"],
  // 마법(장판)
  firezone: ["spell","aoe","fire"]
});

function getPlayerTags(){
  // 나중에 전직/패시브로 확장 가능
  return mergeTags(PLAYER_BASE_TAGS, player.tags || []);
}

function getWeaponTags(){
  // 장비 슬롯 weapon이 아이템(gear)일 수도 있고, 기본 무기(player.weapon)만 있을 수도 있음
  const it = (typeof equipment !== "undefined" && equipment && equipment.weapon) ? equipment.weapon : null;
  const t = [];
  if(it && Array.isArray(it.tags)) t.push(...it.tags);
  // 슬롯/기본 분류
  t.push("weapon");
  if(it && it.slot) t.push(it.slot);
  // 기본 카타나 성격(없으면 melee)
  if(!t.includes("melee") && !t.includes("projectile")) t.push("melee");
  return mergeTags(t);
}

function getMapTags(){
  // tier/seed 기반으로 모드 조건 만들 수 있게 태그화
  const t = ["map"];
  const tier = (mapRun && mapRun.tier) ? mapRun.tier : (typeof mapTier==="number" ? mapTier : 1);
  t.push("tier_"+tier);
  if(tier >= 5) t.push("high_tier");
  if(mapRun && mapRun.bossSpawned) t.push("boss_spawned");
  if(mapRun && mapRun.bossDefeated) t.push("boss_defeated");
  return mergeTags(t);
}

function tagsFromEnemy(e){
  if(!e) return [];
  const t = ["enemy"];
  if(e.type) t.push(e.type);
  if(e.type === "boss") t.push("boss");
  if(e.isElite) t.push("elite");
  if(e.eliteColor) t.push("elite_"+e.eliteColor);
  // 원거리/근거리/마법 태그
  if(e.type === "archer") t.push("projectile");
  if(e.type === "mage") t.push("spell");
  if(e.type === "melee") t.push("melee");
  return mergeTags(t, e.tags || []);
}

/**
 * 공통 전투 컨텍스트 생성
 * @param {string} skillId - "attack" | "ultimate" | "arrow" | "firezone" | ...
 * @param {Object=} enemy
 */
function buildCombatCtx(skillId, enemy){
  const skillTags = SKILL_TAGS[skillId] || ["skill", skillId];
  const tags = mergeTags(
    ["combat","skill", skillId],
    getPlayerTags(),
    getWeaponTags(),
    getMapTags(),
    skillTags,
    tagsFromEnemy(enemy)
  );
  return { scope:"skill", tags, enemy };
}

/** 아웃고잉(내가 주는) 데미지 모드 */
function applyOutgoingDamageMods(baseDmg, ctx){
  if(!USE_TAG_CONTEXTS) return baseDmg;
  if(typeof statFromMods !== "function") return baseDmg;
  // statKey는 "damage"로 통일 (모드에서 requiresAll로 분기)
  return statFromMods(baseDmg, ctx, "damage");
}

/** 인커밍(적이 받는) 데미지 모드 (예: boss takes more) */
function applyEnemyTakenDamageMods(dealt, ctx){
  if(!USE_TAG_CONTEXTS) return dealt;
  if(typeof statFromMods !== "function") return dealt;
  // statKey는 "damage_taken"으로 통일
  return statFromMods(dealt, ctx, "damage_taken");
}

/** 플레이어가 받는 피해 모드 (예: projectile damage taken) */
function applyPlayerTakenDamageMods(incoming, ctx){
  if(!USE_TAG_CONTEXTS) return incoming;
  if(typeof statFromMods !== "function") return incoming;
  return statFromMods(incoming, ctx, "player_damage_taken");
}

/* =========================================================
   ✅ POE식 데미지 "버켓" (Bucket) 레이어
   - base(기본) → add(추가) → increased(증가) → more(추가배율)
   - crit(치명타) → enemy_taken(적이 받는 피해) → player_taken(플레이어가 받는 피해)
   - 지금은 '스칼라(단일 숫자)'로 계산하지만,
     구조를 버켓으로 잡아두면 나중에 물리/원소/카오스 같은
     DamagePacket(다중 타입)로 확장하기 쉬움.
   ========================================================= */

/**
 * 공격자가 주는 피해 계산(아웃고잉 버켓) + 크리/받는피해까지 한 번에 처리
 * @param {number} base - 무기/스킬이 만든 "기본 피해"
 * @param {Object} ctx  - buildCombatCtx() 결과
 * @param {Object=} opt
 * @param {boolean=} opt.canCrit - 기본 true (DOT/지속피해면 false)
 * @returns {{raw:number, afterOutgoing:number, crit:{dmg:number,isCrit:boolean,chance:number,multi:number}, dealt:number}}
 */
function computeFinalDamage(base, ctx, opt){
  opt = opt || {};
  const canCrit = (opt.canCrit !== false);

  // 0) Base → DamagePacket (phys/fire/cold/lightning/chaos)
  const rawPacket = baseToDamagePacket(base, ctx);

  // 1) OUTGOING: add/inc/more (태그 기반) 타입별 적용
  const afterOutgoingPacket = applyOutgoingDamageModsPacket(rawPacket, ctx);

  // 2) CRIT: 모든 타입에 동일 배율 적용 (DOT는 canCrit:false)
  let crit = { dmg: sumDamagePacket(afterOutgoingPacket), isCrit:false, chance:0, multi:1 };
  let afterCritPacket = afterOutgoingPacket;

  if(canCrit){
    const chance = getCritChance();
    const multi = getCritMulti();
    const isCrit = (Math.random() < chance);
    crit = { dmg: isCrit ? sumDamagePacket(afterOutgoingPacket) * multi : sumDamagePacket(afterOutgoingPacket), isCrit, chance, multi };
    afterCritPacket = isCrit ? scaleDamagePacket(afterOutgoingPacket, multi) : afterOutgoingPacket;
  }

  // 3) ENEMY TAKEN: 예) boss takes more (타입별)
  const afterTakenPacket = applyEnemyTakenDamageModsPacket(afterCritPacket, ctx);

  // 4) RESISTS: 적 저항(없으면 0)
  const dealtPacket = applyEnemyResistsPacket(afterTakenPacket, ctx && ctx.enemy);

  return {
    raw: sumDamagePacket(rawPacket),
    rawPacket,
    afterOutgoing: sumDamagePacket(afterOutgoingPacket),
    afterOutgoingPacket,
    crit,
    dealt: sumDamagePacket(dealtPacket),
    dealtPacket
  };
}

/**
 * (옵션) DamagePacket 기반 확장용 최소 구조
 * - 아직은 실제로 쓰지 않지만, "버켓" 구조를 유지하려고 둠.
 */
function makeDamagePacket(phys=0, fire=0, cold=0, lightning=0, chaos=0){
  return { phys, fire, cold, lightning, chaos };
}
function sumDamagePacket(p){
  return (p?.phys||0)+(p?.fire||0)+(p?.cold||0)+(p?.lightning||0)+(p?.chaos||0);
}
function scaleDamagePacket(p, k){
  return makeDamagePacket((p.phys||0)*k, (p.fire||0)*k, (p.cold||0)*k, (p.lightning||0)*k, (p.chaos||0)*k);
}


// ✅ base(숫자) → DamagePacket(phys/fire/cold/lightning/chaos)로 분리
function baseToDamagePacket(base, ctx){
  // base가 이미 packet이면 그대로
  if(base && typeof base === "object" && ("phys" in base || "fire" in base || "cold" in base || "lightning" in base || "chaos" in base)){
    return makeDamagePacket(base.phys||0, base.fire||0, base.cold||0, base.lightning||0, base.chaos||0);
  }
  const v = (typeof base === "number") ? base : 0;

  // 스킬/무기/상황 태그에 따라 원소로 분배 (PoE식: "이 공격은 화염/냉기/번개로 간주" 느낌)
  const tags = (ctx && Array.isArray(ctx.tags)) ? ctx.tags : [];
  const has = (t)=>tags.includes(t);

  const elems = [];
  if(has("fire")) elems.push("fire");
  if(has("cold")) elems.push("cold");
  if(has("lightning")) elems.push("lightning");
  if(has("chaos")) elems.push("chaos");

  // 기본: 물리 100%
  let p = makeDamagePacket(v, 0, 0, 0, 0);

  // 원소 태그가 있으면 "그 원소로 전환" (단순화: 물리를 원소로 분배)
  if(elems.length){
    const share = v / elems.length;
    p.phys = 0;
    for(const e of elems){
      p[e] = (p[e]||0) + share;
    }
  }
  return p;
}

function cloneCtxWithExtraTag(ctx, extraTag){
  if(!ctx) return { scope:"skill", tags:[extraTag] };
  const tags = Array.isArray(ctx.tags) ? ctx.tags.slice() : [];
  if(extraTag && !tags.includes(extraTag)) tags.push(extraTag);
  return { ...ctx, tags };
}

// ✅ OUTGOING / ENEMY_TAKEN을 DamagePacket 단위로 적용
function applyOutgoingDamageModsPacket(pkt, ctx){
  // 각 타입별로 "그 타입 태그"를 추가한 ctx로 계산하면,
  // requiresAll:["fire"] 같은 모드가 fire에만 적용됨.
  const phys = applyOutgoingDamageMods(pkt.phys||0, cloneCtxWithExtraTag(ctx, "physical"));
  const fire = applyOutgoingDamageMods(pkt.fire||0, cloneCtxWithExtraTag(ctx, "fire"));
  const cold = applyOutgoingDamageMods(pkt.cold||0, cloneCtxWithExtraTag(ctx, "cold"));
  const lightning = applyOutgoingDamageMods(pkt.lightning||0, cloneCtxWithExtraTag(ctx, "lightning"));
  const chaos = applyOutgoingDamageMods(pkt.chaos||0, cloneCtxWithExtraTag(ctx, "chaos"));
  return makeDamagePacket(phys, fire, cold, lightning, chaos);
}

function applyEnemyTakenDamageModsPacket(pkt, ctx){
  const phys = applyEnemyTakenDamageMods(pkt.phys||0, cloneCtxWithExtraTag(ctx, "physical"));
  const fire = applyEnemyTakenDamageMods(pkt.fire||0, cloneCtxWithExtraTag(ctx, "fire"));
  const cold = applyEnemyTakenDamageMods(pkt.cold||0, cloneCtxWithExtraTag(ctx, "cold"));
  const lightning = applyEnemyTakenDamageMods(pkt.lightning||0, cloneCtxWithExtraTag(ctx, "lightning"));
  const chaos = applyEnemyTakenDamageMods(pkt.chaos||0, cloneCtxWithExtraTag(ctx, "chaos"));
  return makeDamagePacket(phys, fire, cold, lightning, chaos);
}

// ✅ Enemy Resist(저항) 적용 (없으면 0)
function enemyRes(enemy, key){
  if(!enemy) return 0;
  const v = enemy[key];
  return (typeof v === "number") ? v : 0;
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function applyEnemyResistsPacket(pkt, enemy){
  // res 값은 0~0.9 정도 권장 (0.75 = 75% 저항)
  const physRes = clamp01(enemyRes(enemy, "physRes"));
  const fireRes = clamp01(enemyRes(enemy, "fireRes"));
  const coldRes = clamp01(enemyRes(enemy, "coldRes"));
  const lightningRes = clamp01(enemyRes(enemy, "lightningRes"));
  const chaosRes = clamp01(enemyRes(enemy, "chaosRes"));

  return makeDamagePacket(
    (pkt.phys||0) * (1 - physRes),
    (pkt.fire||0) * (1 - fireRes),
    (pkt.cold||0) * (1 - coldRes),
    (pkt.lightning||0) * (1 - lightningRes),
    (pkt.chaos||0) * (1 - chaosRes)
  );
}


/* 샘플(원하면 지워도 됨): 보스 상대로 10% more 피해
window.GameMods.add({
  id:"sample_vs_boss_more",
  source:"step5_sample",
  scope:"global",
  requiresAll:["boss"],
  stat:"damage",
  op:"more",
  value:0.10
});
*/


/* =========================================================
   (다음 단계 예고)
   - 2단계: createItemInstance()에서 item.mods[] 생성 (data 유지)
   - 3단계: recalcFromGear()에서 statFromMods() 한 겹 적용
   ========================================================= */



/* =========================================================
   Oni Samurai — Maintenance/Stability Patch (v1)
   - Prevent "white screen": show error overlay on JS errors
   - Guard render/update calls so one error doesn't kill everything
   - Adds small helpers ($, $$, assertEl) for safer DOM access
   ========================================================= */
const __ONI_BUILD = "stable-2026-02-26";

/** DOM helpers (safe, tiny) */
const $  = (sel, root=document)=> root.querySelector(sel);
const $$ = (sel, root=document)=> Array.from(root.querySelectorAll(sel));
function assertEl(el, name){
  if(!el){
    throw new Error(`Missing DOM element: ${name}`);
  }
  return el;
}

/** Error overlay so you can see what broke instead of a blank screen */
(function setupErrorOverlay(){
  const box = document.createElement("div");
  box.id = "fatalErrorOverlay";
  box.style.cssText = [
    "position:fixed","inset:0","z-index:999999",
    "background:rgba(0,0,0,0.92)","color:#fff",
    "padding:16px","font:12px/1.4 monospace",
    "white-space:pre-wrap","overflow:auto","display:none"
  ].join(";");
  document.addEventListener("DOMContentLoaded", ()=> document.body.appendChild(box));

  function show(title, err){
    const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err || "");
    box.textContent = `${title}\n\n${msg}\n\n(이 화면이 뜨면, 위 메시지/스크린샷을 보내줘)`;
    box.style.display = "block";
  }

  window.addEventListener("error", (e)=>{
    show("JS Error", e.error || e.message || e);
  });

  window.addEventListener("unhandledrejection", (e)=>{
    show("Promise Rejection", e.reason || e);
  });
})();

/** Safe call wrapper (prevents one exception from killing everything) */
function safeCall(fn, label){
  try{ return fn(); }
  catch(err){
    console.error(`[SAFE:${label}]`, err);
    // Overlay handler will show it too (window error may not fire for caught errors)
    const ov = UI.el("fatalErrorOverlay");
    if(ov){
      ov.style.display = "block";
      ov.textContent = `SAFE ERROR: ${label}\n\n${err && (err.stack||err.message) ? (err.stack||err.message) : String(err)}`;
    }
    return undefined;
  }
}

let gamePaused = false;
let pauseOpts = { dim: 0.60, blur: 2 };
let resumeFade = 0;
let resumeFadeMax = 10;

const pauseCanvas = document.createElement("canvas");
const pauseCtx = pauseCanvas.getContext("2d");

function capturePausedFrame(opts = pauseOpts){
  pauseOpts = opts || pauseOpts;
  draw();
  pauseCanvas.width = canvas.width;
  pauseCanvas.height = canvas.height;

  pauseCtx.setTransform(1,0,0,1,0,0);
  pauseCtx.globalAlpha = 1;
  pauseCtx.filter = (pauseOpts.blur > 0) ? `blur(${pauseOpts.blur}px)` : "none";
  pauseCtx.drawImage(canvas, 0, 0);
  pauseCtx.filter = "none";

  if(pauseOpts.dim > 0){
    pauseCtx.globalAlpha = pauseOpts.dim;
    pauseCtx.fillStyle = "#000";
    pauseCtx.fillRect(0,0,pauseCanvas.width,pauseCanvas.height);
    pauseCtx.globalAlpha = 1;
  }
}

function pauseGame(opts){
  if(gamePaused) return;
  resumeFade = 0;
  capturePausedFrame(opts);
  gamePaused = true;
}

function resumeGame(){
  if(resumeFade > 0) return;
  resumeFade = resumeFadeMax;
  gamePaused = false;
}

let canvas = null;
let ctx = null;

// v2에서는 #ui가 없을 수 있음 → null 안전 처리
let __uiHudHeight = 0; // set by app/UI
  let ui = null; // legacy placeholder

let uiHeight = 0;

function resize(w, h, uiH){
  if(typeof uiH === "number") __uiHudHeight = uiH;

  // uiHeight는 게임 내부 로직(몬스터 스폰/클램프 등)에 쓰일 수 있어서 유지
  uiHeight = (__uiHudHeight || 0);

  // canvas는 app.js에서 bindCanvas로 주입
  if(canvas){
    const cw = (typeof w === "number") ? w : window.innerWidth;
    const ch = (typeof h === "number") ? h : (window.innerHeight - uiHeight);
    canvas.width  = Math.max(1, cw|0);
    canvas.height = Math.max(1, ch|0);
  }

  // DPR 보정(선명도)
  if(canvas && ctx){
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    // canvas 이미 픽셀 기준이면 여기서 스케일만 적용
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
}


/* ===== 사운드 (iOS 대응: 사용자 입력 후 생성) ===== */
let audioCtx = null;
let audioUnlocked = false;

function ensureAudioCtx(){
  if (audioCtx) return true;
  try{
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return true;
  }catch(e){
    console.log("AudioContext blocked:", e);
    return false;
  }
}

function unlockAudio(){
  if (audioUnlocked) return;
  if (!ensureAudioCtx()) return;

  // iOS는 resume도 사용자 제스처에서 호출돼야 안전함
  audioCtx.resume?.();

  // 무음 버퍼 한 번 재생해서 언락(브라우저별 호환)
  try{
    const buffer = audioCtx.createBuffer(1, 1, 22050);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(0);
  }catch(e){
    // 무시
  }

  audioUnlocked = true;
}

// ✅ 첫 터치/클릭에서 오디오 언락
window.addEventListener("pointerdown", unlockAudio, { once:true });
window.addEventListener("touchstart", unlockAudio, { once:true });
window.addEventListener("mousedown", unlockAudio, { once:true });

function startBGM(){
  let isPlaying = true;
  function getTempo(){
    if(killCount >= 100) return 150;
    if(killCount >= 50) return 130;
    return 110;
  }
  function playBeat(){
    if(!isPlaying) return;

    let tempo = getTempo();
    let beatTime = 60 / tempo;
    let now = audioCtx.currentTime;

    let kick = audioCtx.createOscillator();
    let kickGain = audioCtx.createGain();
    kick.type = "triangle";
    kick.frequency.setValueAtTime(90, now);
    kick.frequency.exponentialRampToValueAtTime(50, now + 0.12);
    kickGain.gain.setValueAtTime(0.18, now);
    kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    kick.connect(kickGain);
    kickGain.connect(audioCtx.destination);
    kick.start(now);
    kick.stop(now + 0.15);

    let tone = audioCtx.createOscillator();
    let toneGain = audioCtx.createGain();
    tone.type = "square";
    tone.frequency.value = 220;
    toneGain.gain.setValueAtTime(0.06, now + beatTime/2);
    toneGain.gain.exponentialRampToValueAtTime(0.001, now + beatTime/2 + 0.1);
    tone.connect(toneGain);
    toneGain.connect(audioCtx.destination);
    tone.start(now + beatTime/2);
    tone.stop(now + beatTime/2 + 0.1);

    setTimeout(playBeat, beatTime * 1000);
  }
  playBeat();
  return { stop: () => isPlaying = false };
}
let bgmOsc;

function swingSound(){
  let o=audioCtx.createOscillator();
  let g=audioCtx.createGain();
  o.type="sawtooth";
  o.frequency.setValueAtTime(700,audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(200,audioCtx.currentTime+0.12);
  g.gain.value=0.15;
  o.connect(g); g.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime+0.12);
}
function bossUnsheatheSound(){
  let now = audioCtx.currentTime;

  let o1 = audioCtx.createOscillator();
  let g1 = audioCtx.createGain();
  o1.type = "sawtooth";
  o1.frequency.setValueAtTime(120, now);
  o1.frequency.exponentialRampToValueAtTime(600, now + 0.6);
  g1.gain.setValueAtTime(0.4, now);
  g1.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
  o1.connect(g1);
  g1.connect(audioCtx.destination);
  o1.start(now);
  o1.stop(now + 0.6);

  let o2 = audioCtx.createOscillator();
  let g2 = audioCtx.createGain();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(900, now);
  o2.frequency.exponentialRampToValueAtTime(200, now + 0.4);
  g2.gain.setValueAtTime(0.3, now);
  g2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  o2.connect(g2);
  g2.connect(audioCtx.destination);
  o2.start(now);
  o2.stop(now + 0.4);
}
function thudSound(){
  let now = audioCtx.currentTime;

  let o = audioCtx.createOscillator();
  let g = audioCtx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(120, now);
  o.frequency.exponentialRampToValueAtTime(55, now + 0.14);
  g.gain.setValueAtTime(0.32, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start(now);
  o.stop(now + 0.18);

  let o2 = audioCtx.createOscillator();
  let g2 = audioCtx.createGain();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(220, now);
  o2.frequency.exponentialRampToValueAtTime(90, now + 0.08);
  g2.gain.setValueAtTime(0.12, now);
  g2.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
  o2.connect(g2);
  g2.connect(audioCtx.destination);
  o2.start(now);
  o2.stop(now + 0.09);
}
function hitSound(){
  let o=audioCtx.createOscillator();
  let g=audioCtx.createGain();
  o.type="square";
  o.frequency.value=100;
  g.gain.value=0.25;
  o.connect(g); g.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime+0.08);
}

/* ===== 플레이어 ===== */
let player={
  x:0,y:0,
  dir:"left",
  speed:5,
  radius:14,

  hp:100,
  maxHp:100,
  baseMaxHp:100,

  baseArmor:0,
  invul:0,
  knockbackX:0,
  knockbackY:0,

  kiOrbs:0,
  maxOrbs:5,
  levelGlow:0,
  ultiActive:false,
  ultiCount:0,
  ultiTimer:0,

  buffs: { dmgMul:1, spdMul:1, atkSpdMul:1 },
  activeBuffs: []
};

player.weapon = {
  name: "Rusty Katana",
  min: 14,
  max: 20,
  critChance: 0.06,
  critMulti: 1.50
};

let map = [];
let mapSize = 30;
let tileSize = 48;

for(let y=0; y<mapSize; y++){
  let row = [];
  for(let x=0; x<mapSize; x++){
    if(x===0 || y===0 || x===mapSize-1 || y===mapSize-1) row.push(1);
    else row.push(0);
  }
  map.push(row);
}

player.x = mapSize * tileSize / 2;
player.y = mapSize * tileSize / 2;

let reachableMask = null;
let hpWaveOffset = 0;
let slowMotion = 0;
let spawnTimer = 0;
let spawnInterval = 90;
let enemies=[];
let packs = [];

/* ============================= */
/* ✅ 아이템 드랍/선택 시스템     */
/* ============================= */
let loots = [];
let lootOverlayOpen = false;
let pendingLoot = null;

// ===== UI overlay state (panels / loot choice) =====
// Overlay가 열리면 하단 조작 UI(조이스틱/공격/스킬/루팅/가방)를 숨겨서
// 팝업이 화면을 100% 사용할 수 있게 한다.
let overlayCount = 0;
function overlayPush(){
  overlayCount++;
  document.body.classList.add('overlayActive');
}
function overlayPop(){
  overlayCount = Math.max(0, overlayCount-1);
  if(overlayCount === 0) document.body.classList.remove('overlayActive');
}

const lootOverlay = UI.el("lootOverlay");
const lootCardsEl = UI.el("lootCards");

/* ============================= */
/* ✅ POE식 Affix/Tier/ilvl 시스템 */
/* ============================= */
function getMapTier(){
  // mapTier 소스 다양화(게임/맵/전역)
  const mt =
    (typeof Game !== "undefined" && Game && (Game.mapTier ?? Game.map_tier)) ? (Game.mapTier ?? Game.map_tier) :
    (typeof mapTier !== "undefined" ? mapTier :
    (typeof currentMapTier !== "undefined" ? currentMapTier : 1));
  return Math.max(1, Math.floor(mt || 1));
}

function randRange(a,b){ return a + Math.random()*(b-a); }
function randInt(a,b){
  return (a + Math.floor(Math.random() * (b - a + 1)));
}

/**
 * PoE 느낌: areaLevel ~= mapTier 기반.
 * - mapTier가 오를수록 ilvl 상승
 * - 약간의 랜덤 편차
 * - 플레이어 레벨도 아주 약하게 반영
 */
function rollItemLevelFromMapTier(mt){
  const t = Math.max(1, mt || 1);
  const areaLevel = 1 + t * 5;              // T1=6, T10=51
  const jitter = randInt(-1, 2);            // 약간 흔들림
  const lvl = (typeof level !== "undefined") ? (level || 1) : 1;
  const lvlBonus = Math.floor(lvl * 0.25);  // 플레이어 레벨 약반영
  return Math.max(1, areaLevel + jitter + lvlBonus);
}

// ===============================
// PoE 드랍 정교화: 슬롯/타입 분포 + 중복 방지
// ===============================

// 맵 티어별 슬롯 분포(대략). 합은 1.0 필요 없음(가중치).
const SLOT_WEIGHT_TABLE = [
  // mapTier:1..10 (0은 dummy)
  null,
  { weapon: 55, chest: 20, helmet: 12, boots: 8, ring: 5 },
  { weapon: 52, chest: 21, helmet: 12, boots: 9, ring: 6 },
  { weapon: 48, chest: 22, helmet: 12, boots: 10, ring: 8 },
  { weapon: 45, chest: 22, helmet: 12, boots: 11, ring: 10 },
  { weapon: 42, chest: 22, helmet: 12, boots: 12, ring: 12 },
  { weapon: 40, chest: 22, helmet: 12, boots: 13, ring: 13 },
  { weapon: 38, chest: 22, helmet: 12, boots: 14, ring: 14 },
  { weapon: 36, chest: 22, helmet: 12, boots: 15, ring: 15 },
  { weapon: 35, chest: 22, helmet: 12, boots: 15, ring: 16 },
  { weapon: 34, chest: 22, helmet: 12, boots: 16, ring: 16 },
];

function clampMapTier(t){
  t = (t|0) || 1;
  if(t < 1) t = 1;
  if(t > 10) t = 10;
  return t;
}


// ===============================
// ✅ PoE Base-Specific Mod Pool Bias (B안)
// - 슬롯/태그/베이스(modBias) 기반으로 affix 선택 확률을 미세 조정
// ===============================
const SLOT_MOD_BIAS = {
  weapon: { dmgMul:1.25, atkSpdMul:1.10, critChanceAdd:1.10, critMultiAdd:1.05, rangeMul:1.05, armorAdd:0.15 },
  chest:  { armorAdd:1.25, maxHpAdd:1.15, hpRegen:1.05, dmgMul:0.20, atkSpdMul:0.20, critChanceAdd:0.20 },
  helm:   { armorAdd:1.15, maxHpAdd:1.10, hpRegen:1.10, dmgMul:0.25 },
  boots:  { spdMul:1.20, armorAdd:1.05, maxHpAdd:1.05, dmgMul:0.25 },
  ring:   { maxHpAdd:1.10, hpRegen:1.05, dmgMul:0.60, critChanceAdd:0.60 }
};

// 태그별 2차 바이어스(느슨한 가중치, 필터링 아님)
const TAG_MOD_BIAS = {
  physical: { dmgMul:1.20, critMultiAdd:1.10 },
  melee:    { dmgMul:1.10, rangeMul:1.05 },
  spell:    { dmgMul:0.85, critChanceAdd:0.90 }, // spell 전용 스탯이 있다면 여기서 강화 가능
  caster:   { hpRegen:1.10 },
  block:    { armorAdd:1.10 },
  tank:     { armorAdd:1.20, maxHpAdd:1.15 },
  speed:    { spdMul:1.20, atkSpdMul:1.10 }
};

// ===============================
// ✅ Affix Pool 분리 (PoE식) - B안 Step(1)
// - 단순 "무기/방어구" 분리를 넘어서
//   melee_phys / spell_cast / tank_def 같은 "풀"로 나눠서 확률/후보를 조절
// ===============================

// affix에서 "풀"을 자동 추론 (명시 pool 없으면 group/stat/태그로 추론)
function inferAffixPool(aff, opts){
  if(!aff) return "misc";
  if(aff.pool) return aff.pool;
  if(aff._pool) return aff._pool;

  const g = String(aff.group || aff.stat || "").toLowerCase();
  const stat = String(aff.stat || "").toLowerCase();
  const reqAll = Array.isArray(aff.requiresAll) ? aff.requiresAll : [];
  const hasReq = (t)=>reqAll.includes(t);

  let pool = "misc";

  // 방어/유틸 공통
  if(g.includes("resist") || stat.includes("resist")) pool = "resist";
  else if(g.includes("maxhp") || stat.includes("maxhp") || g.includes("life")) pool = "life";
  else if(g.includes("hpregen") || stat.includes("hpregen")) pool = "regen";
  else if(g.includes("arm") || stat.includes("armor")) pool = "def_armor";
  else if(g.includes("evasion") || stat.includes("evasion")) pool = "def_evasion";
  else if(g.includes("es") || stat.includes("energy")) pool = "def_es";
  else if(g.includes("spd") || stat.includes("spd") || g.includes("movespeed")) pool = "move";

  // 공격 계열
  else if(g.includes("cast") || stat.includes("cast")) pool = "spell_cast";
  else if(g.includes("spell") || stat.includes("spell")) pool = "spell_power";
  else if(g.includes("mana") || stat.includes("mana")) pool = "mana";
  else if(g.includes("bleed") || stat.includes("bleed")) pool = "melee_bleed";
  else if(g.includes("atkspd") || stat.includes("atkspd") || g.includes("attackspeed")) pool = "melee_speed";
  else if(g.includes("critchance") || stat.includes("critchance")) pool = (hasReq("spell") ? "spell_crit" : "melee_crit");
  else if(g.includes("critmulti") || stat.includes("critmulti")) pool = (hasReq("spell") ? "spell_crit" : "melee_crit");
  else if(g.includes("dmgmul") || stat.includes("dmgmul") || g.includes("phys") || stat.includes("phys")) pool = "melee_phys";
  else if(g.includes("range") || stat.includes("range")) pool = "melee_range";

  // 반지 성향
  if(opts && opts.tmpl && (opts.tmpl.slot === "ring" || opts.tmpl.slot === "amulet")){
    if(pool === "melee_phys" || pool === "melee_speed" || pool === "melee_crit") pool = "ring_offense";
    if(pool === "spell_power" || pool === "spell_cast" || pool === "spell_crit") pool = "ring_element";
  }

  aff._pool = pool;
  return pool;
}

// 컨텍스트(슬롯/태그/베이스)에 따라 어떤 풀을 더 선호할지 가중치 생성
// ===============================
// ✅ Hard Pool Locks (출현 가능/불가 잠금)
// - weapon에서 spell 태그가 없으면 spell_* / mana 풀은 완전 차단
// - weapon에서 spell 태그가 있으면 melee_* 풀은 완전 차단
// (생존/저항/유틸 풀은 허용: PoE처럼 '꽝'은 생존/유틸로 남겨둠)
// ===============================
function hardPoolAllowed(poolName, itemTags, opts){
  const tags = Array.isArray(itemTags) ? itemTags : [];
  const has = (t)=>tags.includes(t);
  const slot = opts && opts.tmpl ? opts.tmpl.slot : null;

  // -------- 무기: 지팡이(주문) vs 근접(전쟁지팡이/양손무기) --------
  if(slot === "weapon"){
    const isSpellWeapon = has("spell");
    if(isSpellWeapon){
      if(String(poolName).startsWith("melee_")) return false;
    }else{
      if(String(poolName).startsWith("spell_")) return false;
      if(poolName === "mana") return false;
    }
  }

  // -------- C안: 방어구/투구는 순수 생존/방어 전용 (공격/주문/흡수 차단) --------
  if(slot === "armor" || slot === "helmet"){
    if(String(poolName).startsWith("melee_")) return false;
    if(String(poolName).startsWith("spell_")) return false;
    if(poolName === "ring_offense" || poolName === "ring_element") return false;
    if(poolName === "mana") return false;

    // lifeLeech는 악세/무기만
    if(poolName === "life_leech") return false;

    // 허용 풀만 통과
    const allowed = new Set(["life","regen","resist","def_armor","def_evasion","def_es","move","misc"]);
    if(!allowed.has(poolName)) return false;
  }

  // -------- C안: 반지/목걸이는 공격 옵션 허용 --------
  if(slot === "ring" || slot === "amulet"){
    // 전부 허용(하드락 없음). 단, slot===amulet이면 infer에서 ring_*로 바꿔줄 수 있음.
    return true;
  }

  return true;
}

function applyHardPoolLocksToWeights(w, itemTags, opts){
  for(const k in w){
    if(!hardPoolAllowed(k, itemTags, opts)) w[k] = 0;
  }
  return w;
}

function poolWeightsForContext(kind, itemTags, opts){
  const tags = Array.isArray(itemTags) ? itemTags : [];
  const has = (t)=>tags.includes(t);
  const slot = opts && opts.tmpl ? opts.tmpl.slot : null;

  // 기본 가중치(모든 아이템 공통)
  const w = {
    life: 1.0, resist: 1.0, regen: 0.6, move: 0.5,
    def_armor: 0.8, def_es: 0.8, def_evasion: 0.8,
    melee_phys: 0.7, melee_speed: 0.6, melee_crit: 0.5, melee_bleed: 0.35, melee_range: 0.25,
    spell_power: 0.7, spell_cast: 0.6, spell_crit: 0.45, mana: 0.45,
    ring_offense: 0.7, ring_element: 0.7,
    misc: 0.25
  };

  // 슬롯 기반
  if(slot === "weapon"){
    w.life *= 0.35; w.resist *= 0.35;
    w.def_armor *= 0.10; w.def_es *= 0.10; w.def_evasion *= 0.10; w.move *= 0.10;

    // 태그 기반(무기)
    if(has("spell")){
      w.spell_power *= 2.0; w.spell_cast *= 1.7; w.spell_crit *= 1.25; w.mana *= 1.2;
      w.melee_phys *= 0.15; w.melee_speed *= 0.20; w.melee_crit *= 0.20; w.melee_bleed *= 0.10;
    }else{
      // 공격/근접
      w.melee_phys *= 1.8; w.melee_speed *= 1.45; w.melee_crit *= 1.15; w.melee_range *= 1.05;
      if(has("bleed")) w.melee_bleed *= 2.0;
      w.spell_power *= 0.15; w.spell_cast *= 0.15; w.spell_crit *= 0.15; w.mana *= 0.20;
    }
  }
  else if(slot === "chest" || slot === "helm" || slot === "boots"){
    w.life *= 1.35; w.resist *= 1.25;
    w.melee_phys *= 0.10; w.melee_speed *= 0.10; w.melee_crit *= 0.10;
    w.spell_power *= 0.10; w.spell_cast *= 0.10; w.spell_crit *= 0.10; w.mana *= 0.10;

    if(slot === "boots"){ w.move *= 2.0; }
    if(has("armor")) w.def_armor *= 1.6;
    if(has("es")) w.def_es *= 1.6;
    if(has("evasion")) w.def_evasion *= 1.6;
  }
  else if(slot === "ring"){
    w.life *= 1.15; w.resist *= 1.45;
    w.ring_offense *= 1.2; w.ring_element *= 1.2;
    // 반지는 공격/방어 섞이게 유지
  }

  // prefix/suffix에 따른 분위기(아주 약하게)
  if(kind === "prefix"){
    w.life *= 1.10; w.def_armor *= 1.10; w.def_es *= 1.10; w.def_evasion *= 1.10;
    w.melee_phys *= 1.05; w.spell_power *= 1.05;
  }else{
    w.resist *= 1.20; w.move *= 1.10; w.critChanceAdd ? (w.melee_crit *= 1.05) : 0;
  }

  // 베이스 modBias(그룹 바이어스)와는 별개로, baseId 특성 태그로 풀을 조금 더 보정
  if(opts && opts.tmpl && opts.tmpl.tags){
    const bt = opts.tmpl.tags;
    const bHas = (t)=>bt.includes(t);
    // 전쟁지팡이(근접) 강조
    if(bHas("warstaff")){
      w.melee_phys *= 1.25; w.melee_range *= 1.20; w.melee_speed *= 1.10;
      w.spell_power *= 0.35; w.spell_cast *= 0.35;
    }
    // 지팡이(주문) 강조
    if(bHas("staff")){
      w.spell_power *= 1.35; w.spell_cast *= 1.25; w.spell_crit *= 1.10; w.mana *= 1.15;
      w.melee_phys *= 0.35; w.melee_speed *= 0.35; w.melee_crit *= 0.35;
    }
  }

  return applyHardPoolLocksToWeights(w, itemTags, opts);
}

function getBiasMul(map, key, group){
  const row = map && map[key];
  if(!row) return 1;
  const m = row[group];
  return (typeof m === "number" && isFinite(m)) ? m : 1;
}

function affixEffectiveWeight(affix, opts){
  const baseW = Math.max(0, (affix && affix.weight != null) ? affix.weight : 100);
  if(!affix) return 0;
  const group = affix.group || "";
  let mul = 1;

  const tmpl = opts && opts.tmpl ? opts.tmpl : null;
  const tags = opts && Array.isArray(opts.itemTags) ? opts.itemTags : null;

  // 슬롯 바이어스
  if(tmpl && tmpl.slot) mul *= getBiasMul(SLOT_MOD_BIAS, tmpl.slot, group);

  // 베이스 전용 바이어스
  if(tmpl && tmpl.modBias && typeof tmpl.modBias === "object"){
    const bm = tmpl.modBias[group];
    if(typeof bm === "number" && isFinite(bm)) mul *= bm;
  }

  // 태그 바이어스
  if(tags){
    for(const t of tags){
      mul *= getBiasMul(TAG_MOD_BIAS, t, group);
    }
  }

  // 과도한 왜곡 방지
  if(mul < 0.05) mul = 0.05;
  if(mul > 6.0) mul = 6.0;

  return baseW * mul;
}

function weightedPickAffix(list, opts){
  const arr = Array.isArray(list) ? list : [];
  if(!arr.length) return null;

  let sum = 0;
  const ws = new Array(arr.length);
  for(let i=0;i<arr.length;i++){
    const w = affixEffectiveWeight(arr[i], opts);
    ws[i] = w;
    sum += w;
  }
  if(!(sum > 0)) return arr[Math.floor(Math.random()*arr.length)] || null;

  let r = Math.random() * sum;
  for(let i=0;i<arr.length;i++){
    r -= ws[i];
    if(r <= 0) return arr[i];
  }
  return arr[arr.length-1] || null;
}

function weightedPickFromMap(obj){
  const entries = Object.entries(obj || {});
  let total = 0;
  for(const [,w] of entries) total += Math.max(0, w||0);
  if(total <= 0) return null;
  let r = Math.random() * total;
  for(const [k,w0] of entries){
    const w = Math.max(0, w0||0);
    r -= w;
    if(r <= 0) return k;
  }
  return entries[entries.length-1]?.[0] || null;
}

function pickSlotForMapTier(mapTier){
  const t = clampMapTier(mapTier);
  const row = SLOT_WEIGHT_TABLE[t] || SLOT_WEIGHT_TABLE[1];
  return weightedPickFromMap(row) || "weapon";
}

// 타입별 멀티플라이어(“멋/희소성” 느낌). 무기만 적용.
const WEAPON_TYPE_WEIGHT_MULT = {
  "2h_sword": 1.00,
  "2h_axe":   0.95,
  "2h_mace":  0.95,
  "staff":    0.90,
  "warstaff": 0.85
};

function inferWeaponType(base){
  const tags = base?.tags || [];
  if(tags.includes("2h_sword")) return "2h_sword";
  if(tags.includes("2h_axe")) return "2h_axe";
  if(tags.includes("2h_mace")) return "2h_mace";
  if(tags.includes("warstaff")) return "warstaff";
  if(tags.includes("staff")) return "staff";
  return null;
}

function getEligibleBasePoolBySlot(mapTier, slot){
  const t = clampMapTier(mapTier);
  return (ITEM_POOL || []).filter(b=>{
    if(!b) return false;
    if(slot && b.slot !== slot) return false;
    const bt = (b.baseTier ?? 1);
    if(bt > t) return false; // 티어 해금
    return true;
  });
}

function pickBaseForMapTier(mapTier, slot){
  const t = clampMapTier(mapTier);
  const wantTier = pickBaseTierForMap(t); // 이미 step3에서 정의됨
  // 1) 원하는 티어부터 아래로 내려오며 찾기
  for(let tier = wantTier; tier >= 1; tier--){
    const pool = getEligibleBasePoolBySlot(t, slot).filter(b => (b.baseTier ?? 1) === tier);
    if(!pool.length) continue;

    // 가중치 적용(무기는 타입 멀티플라이어 추가)
    const weights = pool.map(b=>{
      let w = (b.weight ?? 100);
      if(b.slot === "weapon"){
        const wt = inferWeaponType(b);
        const mult = wt ? (WEAPON_TYPE_WEIGHT_MULT[wt] ?? 1) : 1;
        w = w * mult;
      }
      return Math.max(1, w);
    });

    // 안전 가중치 픽
    let total = 0;
    for(const w of weights) total += w;
    let r = Math.random() * total;
    for(let i=0;i<pool.length;i++){
      r -= weights[i];
      if(r <= 0) return pool[i];
    }
    return pool[pool.length-1];
  }

  // 2) 최후 fallback: 아무거나
  const any = getEligibleBasePoolBySlot(t, slot);
  return any[0] || null;
}



// ✅ item level (ilvl)
function getItemLevel(){
  return rollItemLevelFromMapTier(getMapTier());
}

// ✅ 맵 티어 ↔ 베이스 티어 해금(상한)
// (moved) getMaxBaseTierForMap is defined above
function getMaxBaseTierForMap(t){ return 5; }

function getBaseTierDistribution(mt){
  const t = Math.max(1, Math.floor(mt || 1));
  if(BASE_TIER_DISTRIBUTION[t]) return BASE_TIER_DISTRIBUTION[t];
  // 10 이상은 10을 기준으로 더 고티어 편중
  return BASE_TIER_DISTRIBUTION[10];
}

function pickBaseTierForMap(mt){
  const dist = getBaseTierDistribution(mt);
  // 해금 상한 적용
  const maxTier = getMaxBaseTierForMap(mt);
  let total = 0;
  for(let i=0;i<dist.length;i++){
    const tier = i+1;
    if(tier > maxTier) continue;
    total += dist[i];
  }
  let r = Math.random() * total;
  for(let i=0;i<dist.length;i++){
    const tier = i+1;
    if(tier > maxTier) continue;
    r -= dist[i];
    if(r <= 0) return tier;
  }
  return Math.min(5, maxTier);
}

function tierCurveMultiplier(mt, baseTier){
  // dist 기반 multiplier: 0~1
  const dist = getBaseTierDistribution(mt);
  const idx = Math.max(0, Math.min(4, (baseTier||1)-1));
  return dist[idx] || 0;
}

function getMaxBaseTierForMap(t){
  // ✅ 맵 티어 ↔ 베이스 티어 연동 (대충 PoE 느낌)
  // T1~2 : tier1 / T3~4 : tier2 / T5~6 : tier3 / T7~8 : tier4 / T9+ : tier5
  if(t <= 2) return 1;
  if(t <= 4) return 2;
  if(t <= 6) return 3;
  if(t <= 8) return 4;
  return 5;
}

function getEligibleBasePool(mapTier){
  const mt = Math.max(1, (mapTier ?? getMapTier()));
  const pool = Array.isArray(ITEM_POOL) ? ITEM_POOL : [];
  const maxTier = getMaxBaseTierForMap(mt);

  return pool.filter(base=>{
    if(!base) return false;
    const baseTier = (base.baseTier ?? 1);
    if(baseTier < 1 || baseTier > 5) return false;
    if(baseTier > maxTier) return false;
    // minIlvl도 숫자 보정
    base.minIlvl = (base.minIlvl ?? 1);
    base.weight = (base.weight ?? 100);
    return true;
  });
}

function pickBaseTemplateUnique(pool, usedIds){
  // 가중치 드랍
  const picks = pool.filter(p => !usedIds.has(p.id));
  if(!picks.length) return null;
  const tmp = picks.map(p => ({
    ref:p,
    weight: Math.max(1, (p.weight ?? 50) * (1 + ((p.baseTier ?? 1)-1)*0.18))
  }));
  const chosen = weightedPick(tmp, "weight");
  return chosen ? chosen.ref : null;
}

function weightedPick(list, weightKey="weight"){
  let total = 0;
  for(const it of list) total += (it[weightKey] ?? 0);
  let r = Math.random() * total;
  for(const it of list){
    r -= (it[weightKey] ?? 0);
    if(r <= 0) return it;
  }
  return list[list.length - 1];
}


const AFFIX_DB = {
  // ===============================
  // PREFIX: 주로 "핵심 방향" (피해% / 주문% / 방어% / 저항 / 최대생명력)
  // SUFFIX: 주로 "보조 강화" (공속/범위/치확/치피/이속/재생/흡수 등)
  // - tiers: T6(낮음) ~ T1(높음)
  // - minIlvl: ilvl 게이팅
  // ===============================
  prefix: [

    // ====== 무기: 근접(기본) ======
    {
      id:"p_melee_phys",
      name:"맹렬한",
      group:"phys",
      weight:120,
      tiers:[
        {t:6,minIlvl:1, min:4,  max:8},
        {t:5,minIlvl:10,min:8,  max:12},
        {t:4,minIlvl:20,min:12, max:16},
        {t:3,minIlvl:35,min:16, max:22},
        {t:2,minIlvl:50,min:22, max:30},
        {t:1,minIlvl:70,min:30, max:40}
      ],
      apply:(d,v)=>{ d.dmgMul = (d.dmgMul||1) * (1+v/100); }
    },
    {
      id:"p_melee_flat_phys",
      name:"잔혹한",
      group:"phys_flat",
      weight:110,
      tiers:[
        {t:6,minIlvl:1, min:1, max:2},
        {t:5,minIlvl:10,min:2, max:3},
        {t:4,minIlvl:20,min:3, max:5},
        {t:3,minIlvl:35,min:5, max:7},
        {t:2,minIlvl:50,min:7, max:10},
        {t:1,minIlvl:70,min:10,max:14}
      ],
      apply:(d,v)=>{ d.flatDamage = (d.flatDamage||0) + v; }
    },

    // ====== 무기: 원소(근접/주문 공통) ======
    {
      id:"p_elem_fire",
      name:"불타는",
      group:"fire_damage",
      weight:90,
      tiers:[
        {t:6,minIlvl:1, min:4,  max:8},
        {t:5,minIlvl:10,min:8,  max:12},
        {t:4,minIlvl:20,min:12, max:16},
        {t:3,minIlvl:35,min:16, max:22},
        {t:2,minIlvl:50,min:22, max:30},
        {t:1,minIlvl:70,min:30, max:40}
      ],
      apply:(d,v)=>{ d.fireMul = (d.fireMul||1) * (1+v/100); }
    },
    {
      id:"p_elem_cold",
      name:"서릿발의",
      group:"cold_damage",
      weight:85,
      tiers:[
        {t:6,minIlvl:1, min:4,  max:8},
        {t:5,minIlvl:10,min:8,  max:12},
        {t:4,minIlvl:20,min:12, max:16},
        {t:3,minIlvl:35,min:16, max:22},
        {t:2,minIlvl:50,min:22, max:30},
        {t:1,minIlvl:70,min:30, max:40}
      ],
      apply:(d,v)=>{ d.coldMul = (d.coldMul||1) * (1+v/100); }
    },
    {
      id:"p_elem_light",
      name:"폭풍의",
      group:"light_damage",
      weight:85,
      tiers:[
        {t:6,minIlvl:1, min:4,  max:8},
        {t:5,minIlvl:10,min:8,  max:12},
        {t:4,minIlvl:20,min:12, max:16},
        {t:3,minIlvl:35,min:16, max:22},
        {t:2,minIlvl:50,min:22, max:30},
        {t:1,minIlvl:70,min:30, max:40}
      ],
      apply:(d,v)=>{ d.lightMul = (d.lightMul||1) * (1+v/100); }
    },

    // ====== 무기: 주문 전용(지팡이) ======
    {
      id:"p_spell_power",
      name:"비전의",
      group:"spell_damage",
      requiresAll:["spell"],
      weight:120,
      tiers:[
        {t:6,minIlvl:1, min:4,  max:8},
        {t:5,minIlvl:10,min:8,  max:12},
        {t:4,minIlvl:20,min:12, max:16},
        {t:3,minIlvl:35,min:16, max:22},
        {t:2,minIlvl:50,min:22, max:30},
        {t:1,minIlvl:70,min:30, max:40}
      ],
      apply:(d,v)=>{ d.spellMul = (d.spellMul||1) * (1+v/100); }
    },

    // ===============================
    // 방어구/투구: PREFIX (핵심 생존/방어)
    // ===============================
    {
      id:"p_life_big",
      name:"거대한",
      group:"life",
      weight:130,
      tiers:[
        {t:6,minIlvl:1, min:8,  max:12},
        {t:5,minIlvl:10,min:12, max:18},
        {t:4,minIlvl:20,min:18, max:25},
        {t:3,minIlvl:35,min:25, max:35},
        {t:2,minIlvl:50,min:35, max:45},
        {t:1,minIlvl:70,min:45, max:60}
      ],
      apply:(d,v)=>{ d.maxHP = (d.maxHP||0) + v; }
    },
    {
      id:"p_armor_pct",
      name:"견고한",
      group:"armor_pct",
      weight:120,
      tiers:[
        {t:6,minIlvl:1, min:6,  max:10},
        {t:5,minIlvl:10,min:10, max:14},
        {t:4,minIlvl:20,min:14, max:18},
        {t:3,minIlvl:35,min:18, max:24},
        {t:2,minIlvl:50,min:24, max:32},
        {t:1,minIlvl:70,min:32, max:45}
      ],
      apply:(d,v)=>{ d.armorMul = (d.armorMul||1) * (1+v/100); }
    },
    {
      id:"p_res_all",
      name:"수호의",
      group:"resist_all",
      weight:90,
      tiers:[
        {t:6,minIlvl:1, min:3,  max:6},
        {t:5,minIlvl:12,min:6,  max:9},
        {t:4,minIlvl:24,min:9,  max:12},
        {t:3,minIlvl:36,min:12, max:16},
        {t:2,minIlvl:52,min:16, max:20},
        {t:1,minIlvl:72,min:20, max:26}
      ],
      apply:(d,v)=>{
        d.resAll = (d.resAll||0) + v;
      }
    },
    {
      id:"p_res_fire",
      name:"불굴의",
      group:"resist_fire",
      weight:95,
      tiers:[
        {t:6,minIlvl:1, min:6,  max:10},
        {t:5,minIlvl:10,min:10, max:14},
        {t:4,minIlvl:20,min:14, max:18},
        {t:3,minIlvl:35,min:18, max:22},
        {t:2,minIlvl:50,min:22, max:28},
        {t:1,minIlvl:70,min:28, max:35}
      ],
      apply:(d,v)=>{ d.resFire = (d.resFire||0) + v; }
    },
    {
      id:"p_res_cold",
      name:"냉혹의",
      group:"resist_cold",
      weight:95,
      tiers:[
        {t:6,minIlvl:1, min:6,  max:10},
        {t:5,minIlvl:10,min:10, max:14},
        {t:4,minIlvl:20,min:14, max:18},
        {t:3,minIlvl:35,min:18, max:22},
        {t:2,minIlvl:50,min:22, max:28},
        {t:1,minIlvl:70,min:28, max:35}
      ],
      apply:(d,v)=>{ d.resCold = (d.resCold||0) + v; }
    },
    {
      id:"p_res_light",
      name:"번개의",
      group:"resist_light",
      weight:95,
      tiers:[
        {t:6,minIlvl:1, min:6,  max:10},
        {t:5,minIlvl:10,min:10, max:14},
        {t:4,minIlvl:20,min:14, max:18},
        {t:3,minIlvl:35,min:18, max:22},
        {t:2,minIlvl:50,min:22, max:28},
        {t:1,minIlvl:70,min:28, max:35}
      ],
      apply:(d,v)=>{ d.resLight = (d.resLight||0) + v; }
    }

  ],

  // ===============================
  // SUFFIX
  // ===============================
  suffix: [

    // ===== 무기 공통 보조(요청: 공속/범위/치확/치피는 접미) =====
    {
      id:"s_attack_speed",
      name:"학살자의",
      group:"attackspeed",
      weight:100,
      tiers:[
        {t:6,minIlvl:1, min:1, max:2},
        {t:5,minIlvl:10,min:2, max:3},
        {t:4,minIlvl:20,min:3, max:4},
        {t:3,minIlvl:35,min:4, max:6},
        {t:2,minIlvl:50,min:6, max:8},
        {t:1,minIlvl:70,min:8, max:12}
      ],
      apply:(d,v)=>{ d.attackSpeedMul = (d.attackSpeedMul||1) * (1+v/100); }
    },
    {
      id:"s_range",
      name:"확장의",
      group:"range",
      weight:90,
      tiers:[
        {t:6,minIlvl:1, min:1, max:2},
        {t:5,minIlvl:10,min:2, max:3},
        {t:4,minIlvl:20,min:3, max:4},
        {t:3,minIlvl:35,min:4, max:6},
        {t:2,minIlvl:50,min:6, max:8},
        {t:1,minIlvl:70,min:8, max:12}
      ],
      apply:(d,v)=>{ d.rangeMul = (d.rangeMul||1) * (1+v/100); }
    },
    {
      id:"s_crit_chance",
      name:"살기의",
      group:"critchance",
      weight:90,
      tiers:[
        {t:6,minIlvl:1, min:0.5, max:1.0},
        {t:5,minIlvl:10,min:1.0, max:1.5},
        {t:4,minIlvl:20,min:1.5, max:2.5},
        {t:3,minIlvl:35,min:2.5, max:3.5},
        {t:2,minIlvl:50,min:3.5, max:4.5},
        {t:1,minIlvl:70,min:4.5, max:6.0}
      ],
      apply:(d,v)=>{ d.critChanceAdd = (d.critChanceAdd||0) + (v/100); }
    },
    {
      id:"s_crit_multi",
      name:"암살자의",
      group:"critmulti",
      weight:75,
      tiers:[
        {t:6,minIlvl:1, min:10, max:20},
        {t:5,minIlvl:12,min:20, max:28},
        {t:4,minIlvl:24,min:28, max:36},
        {t:3,minIlvl:36,min:36, max:45},
        {t:2,minIlvl:52,min:45, max:55},
        {t:1,minIlvl:72,min:55, max:70}
      ],
      apply:(d,v)=>{ d.critMultiAdd = (d.critMultiAdd||0) + (v/100); }
    },

    // ===== 생존(모든 슬롯 공통: 악세에도 허용) =====
    {
      id:"s_max_life",
      name:"생명의",
      group:"life",
      weight:120,
      tiers:[
        {t:6,minIlvl:1, min:8,  max:12},
        {t:5,minIlvl:10,min:12, max:18},
        {t:4,minIlvl:20,min:18, max:25},
        {t:3,minIlvl:35,min:25, max:35},
        {t:2,minIlvl:50,min:35, max:45},
        {t:1,minIlvl:70,min:45, max:60}
      ],
      apply:(d,v)=>{ d.maxHP = (d.maxHP||0) + v; }
    },

    // 생명력 흡수는 악세/무기에만 (방어구/투구는 C안이라 차단)
    {
      id:"s_life_leech",
      name:"흡수의",
      group:"life_leech",
      weight:70,
      tiers:[
        {t:6,minIlvl:10,min:1, max:2},
        {t:5,minIlvl:25,min:2, max:3},
        {t:4,minIlvl:40,min:3, max:4},
        {t:3,minIlvl:55,min:4, max:5},
        {t:2,minIlvl:70,min:5, max:6},
        {t:1,minIlvl:80,min:6, max:8}
      ],
      apply:(d,v)=>{ d.lifeLeech = (d.lifeLeech||0) + (v/100); }
    },

    // ===== 방어구/투구: SUFFIX (보조 유틸) =====
    {
      id:"s_move_speed",
      name:"신속의",
      group:"movespeed",
      weight:90,
      tiers:[
        {t:6,minIlvl:1, min:1, max:2},
        {t:5,minIlvl:12,min:2, max:3},
        {t:4,minIlvl:24,min:3, max:4},
        {t:3,minIlvl:36,min:4, max:6},
        {t:2,minIlvl:52,min:6, max:8},
        {t:1,minIlvl:72,min:8, max:12}
      ],
      apply:(d,v)=>{ d.moveSpeedMul = (d.moveSpeedMul||1) * (1+v/100); }
    },
    {
      id:"s_regen",
      name:"재생의",
      group:"hpregen",
      weight:85,
      tiers:[
        {t:6,minIlvl:1, min:0.05, max:0.10},
        {t:5,minIlvl:12,min:0.10, max:0.16},
        {t:4,minIlvl:24,min:0.16, max:0.22},
        {t:3,minIlvl:36,min:0.22, max:0.30},
        {t:2,minIlvl:52,min:0.30, max:0.40},
        {t:1,minIlvl:72,min:0.40, max:0.55}
      ],
      apply:(d,v)=>{ d.hpRegen = (d.hpRegen||0) + v; }
    }

  ]
};


function rollTierValue(affix, ilvl){
  // PoE식: ilvl에 따라 사용 가능한 tier만 선택
  if(!affix) return null;

  const tiers = Array.isArray(affix.tiers) ? affix.tiers : null;
  if(!tiers || !tiers.length){
    // tiers가 없는 옛 affix는 단일 값으로 처리
    const v = (typeof affix.value === "number") ? affix.value : 0;
    return { tier: 1, value: v };
  }

  const avail = tiers.filter(t => t && typeof t.minIlvl === "number" ? (ilvl >= t.minIlvl) : true);
  if(!avail.length) return null;

  const picked = weightedPick(avail.map(t=>({ ...t, weight:(t.w ?? 1) })));
  if(!picked) return null;

  const isInt = Number.isInteger(picked.min) && Number.isInteger(picked.max);
  let v = picked.min + Math.random() * (picked.max - picked.min);
  if(isInt) v = Math.floor(v);
  else v = Math.round(v * 1000) / 1000;

  return { tier:picked.t ?? 1, value:v };
}
function maxAffixesForRarity(r){
  // PoE: normal=0, magic=2, rare=6, unique(유니크)=0(고정모드)
  r = normalizeRarity(r);
  if(r === "normal") return 0;
  if(r === "magic") return 2;
  if(r === "rare") return 6;
  if(r === "unique") return 0;
  return 0;
}
function maxPrefixForRarity(r){ r = normalizeRarity(r); return (r === "rare") ? 3 : (r === "magic" ? 1 : 0); }
function maxSuffixForRarity(r){ r = normalizeRarity(r); return (r === "rare") ? 3 : (r === "magic" ? 1 : 0); }

function tagsPass(itemTags, obj){
  const tags = Array.isArray(itemTags) ? itemTags : [];
  const all = (obj && obj.requiresAll) ? obj.requiresAll : [];
  const any = (obj && obj.requiresAny) ? obj.requiresAny : [];
  const forb = (obj && obj.forbids) ? obj.forbids : [];

  for(const t of forb){ if(tags.includes(t)) return false; }
  for(const t of all){ if(!tags.includes(t)) return false; }
  if(any.length){
    let ok = false;
    for(const t of any){ if(tags.includes(t)){ ok = true; break; } }
    if(!ok) return false;
  }
  return true;
}

function clampAffixLimits(affixes, rarity){
  if(!Array.isArray(affixes)) return [];
  const maxPre = maxPrefixForRarity(rarity);
  const maxSuf = maxSuffixForRarity(rarity);
  const maxTot = maxAffixesForRarity(rarity);

  const pre = affixes.filter(a=>a && a.kind==="prefix").slice(0, maxPre);
  const suf = affixes.filter(a=>a && a.kind==="suffix").slice(0, maxSuf);

  const out = [];
  out.push(...pre);
  out.push(...suf);
  return out.slice(0, maxTot);
}

function rollAffixesPOE(rarity, ilvl, itemTags, opts={}){
  rarity = normalizeRarity(rarity);
  opts.itemTags = itemTags;
  if(rarity === "unique") return [];
  // opts: { total=null, pre=null, suf=null, existingAffixes=null, add=false, keepExisting=false }
  const maxTot = maxAffixesForRarity(rarity);
  const maxPre = maxPrefixForRarity(rarity);
  const maxSuf = maxSuffixForRarity(rarity);

  let targetTot = (typeof opts.total === "number") ? Math.max(0, Math.min(maxTot, opts.total)) : maxTot;

  // PoE 느낌 랜덤 개수:
  // - 매직: 1~2
  // - 레어: 3~4
  // - 에픽: 4~6
  if(opts.total == null){
    if(rarity === "magic") targetTot = (Math.random() < 0.55 ? 1 : 2);
    else if(rarity === "rare") targetTot = (Math.random() < 0.55 ? 3 : 4);
    else if(rarity === "rare"){
      const r = Math.random();
      targetTot = (r < 0.40 ? 4 : (r < 0.75 ? 5 : 6));
    }else targetTot = 0;
  }

  const existing = Array.isArray(opts.existingAffixes) ? opts.existingAffixes : [];
  const keepExisting = !!opts.keepExisting;
  const addMode = !!opts.add;

  let picked = keepExisting ? existing.slice() : [];
  picked = clampAffixLimits(picked, rarity);

  const usedGroups = new Set(picked.map(a=>a && a.affix ? a.affix.group : "").filter(Boolean));

  function eligiblePool(pool, poolName){
    return pool.filter(a => {
      if(!a) return false;
      if(usedGroups.has(a.group)) return false;
      if(!tagsPass(itemTags, a)) return false;

      // ✅ ilvl tier gating: 해당 affix에 ilvl에서 사용할 수 있는 tier가 1개라도 있어야 함
      if(Array.isArray(a.tiers) && a.tiers.length){
        const ok = a.tiers.some(t => t && (typeof t.minIlvl === "number" ? (ilvl >= t.minIlvl) : true));
        if(!ok) return false;
      }

      // ✅ Pool gating + Hard Locks
      const p = inferAffixPool(a, opts);
      if(!hardPoolAllowed(p, itemTags, opts)) return false;
    // 무기에는 방어구 전용(방어도/저항) 접두가 뜨지 않게 하드 차단 (tmpl이 없을 때도 tags로 판별)
      const slot = (opts && opts.tmpl) ? opts.tmpl.slot : null;
      const isWeapon = (slot === "weapon") || (Array.isArray(itemTags) && (itemTags.includes("weapon") || itemTags.includes("attack")));
      if(isWeapon){
        const g = String(a.group||"").toLowerCase();
        const bannedWeaponGroups = new Set(["armor_pct","resist_all","resist_fire","resist_cold","resist_light"]);
        if(bannedWeaponGroups.has(g)) return false;
      }

      if(poolName){
        if(p !== poolName) return false;
      }
      return true;
    });
  }

  function pickOne(kind, pool){
    // 1) 컨텍스트에 맞는 "풀"을 먼저 선택
    const pw = poolWeightsForContext(kind, itemTags, opts);
    let desiredPool = weightedPickFromMap(pw);

    // 2) 선택된 풀에서 먼저 뽑기
    if(desiredPool){
      const eligP = eligiblePool(pool, desiredPool);
      if(eligP.length) return weightedPickAffix(eligP, opts);
    }

    // 3) 실패하면 전체에서 뽑기(드랍/크래시 방지)
    const elig = eligiblePool(pool, null);
    if(!elig.length) return null;
    return weightedPickAffix(elig, opts);
  }

  let guard = 0;
  while(picked.length < targetTot && guard++ < 1200){
    // prefix/suffix 밸런스: 최대치 넘지 않게
    const preCount = picked.filter(x=>x.kind==="prefix").length;
    const sufCount = picked.filter(x=>x.kind==="suffix").length;

    let kind = "prefix";
    if(preCount >= maxPre) kind = "suffix";
    else if(sufCount >= maxSuf) kind = "prefix";
    else kind = (Math.random() < 0.5 ? "prefix" : "suffix");

    const cand = (kind === "prefix")
      ? pickOne(kind, AFFIX_DB.prefix)
      : pickOne(kind, AFFIX_DB.suffix);

    if(!cand) break;
    if(usedGroups.has(cand.group)) continue;

    usedGroups.add(cand.group);
    const rr = rollTierValue(cand, ilvl);
    if(!rr) continue;
    picked.push({ kind, affix:cand, tier:rr.tier, value:rr.value });
  }

  if(addMode){
    // addMode: existing + 1개만 추가하고 싶을 때 (Aug/Regal/Exalt 용)
    // opts.keepExisting=true + opts.total = existing.length + 1 형태로 사용
    // 여기서는 그냥 clamp만 보장
    picked = clampAffixLimits(picked, rarity);
  }

  return picked;
}

function rerollValuesPOE(affixes, ilvl){
  if(!Array.isArray(affixes)) return [];
  return affixes.map(r=>{
    if(!r || !r.affix) return r;
    const tiers = Array.isArray(r.affix.tiers) ? r.affix.tiers : [];
    const t = tiers.find(x => x && x.t === r.tier);
    if(!t) return r;
    const isInt = Number.isInteger(t.min) && Number.isInteger(t.max);
    let v = t.min + Math.random() * (t.max - t.min);
    if(isInt) v = Math.floor(v);
    else v = Math.round(v * 1000) / 1000;
    return { ...r, value:v };
  });
}

function makeEmptyItemData(){
  return {
    dmgMul: 1,
    rangeMul: 1,
    spdMul: 1,
    armorAdd: 0,
    maxHpAdd: 0,
    hpRegen: 0,
    critChanceAdd: 0,
    critMultiAdd: 0
  };
}
function mergeItemData(baseData, affixData){
  const out = makeEmptyItemData();
  out.dmgMul   = (baseData.dmgMul   ?? 1) * (affixData.dmgMul   ?? 1);
  out.rangeMul = (baseData.rangeMul ?? 1) * (affixData.rangeMul ?? 1);
  out.spdMul   = (baseData.spdMul   ?? 1) * (affixData.spdMul   ?? 1);

  out.armorAdd      = (baseData.armorAdd      ?? 0) + (affixData.armorAdd      ?? 0);
  out.maxHpAdd      = (baseData.maxHpAdd      ?? 0) + (affixData.maxHpAdd      ?? 0);
  out.hpRegen       = (baseData.hpRegen       ?? 0) + (affixData.hpRegen       ?? 0);
  out.critChanceAdd = (baseData.critChanceAdd ?? 0) + (affixData.critChanceAdd ?? 0);
  out.critMultiAdd  = (baseData.critMultiAdd  ?? 0) + (affixData.critMultiAdd  ?? 0);
  return out;
}



function getItemTemplateById(id){
  const pool = Array.isArray(ITEM_POOL) ? ITEM_POOL : [];
  let t = pool.find(x => x.id === id);
  if(!t){
    // fallback: first weapon or first item
    t = pool.find(x => x.slot === "weapon") || pool[0] || null;
  }
  return t;
}

function buildBaseDataFromItemId(itemId){
  // ✅ PoE식: 베이스의 "기본 수치"는 템플릿에 정의된 고정값을 사용
  // - 접두/접미/암묵(implicit)은 별도 레이어에서 적용
  const base = makeEmptyItemData();
  const id = String(itemId||"");
  const tmpl = getItemTemplateById(id);

  if(!tmpl || !tmpl.baseData) return base;

  const bd = tmpl.baseData;

  // 기본 규칙:
  // - *Mul 계열(dmgMul/spdMul/rangeMul/elemDmgMul 등)은 곱
  // - 그 외 Add/Min/Max/Res 계열은 더함
  for(const k of Object.keys(bd)){
    const v = bd[k];
    if(v == null) continue;
    if(k.endsWith("Mul")){
      base[k] = (base[k] ?? 1) * v;
    } else {
      base[k] = (base[k] ?? 0) + v;
    }
  }
  return base;
}



const ITEM_POOL = [
  // =========================================================
  // ✅ PoE식 "베이스" 풀 (완전 리뉴얼)
  // - baseTier: 맵티어에 따라 해금
  // - minIlvl  : 베이스 최소 아이템 레벨
  // - baseData : 베이스 고정 스탯(암묵과 별개)
  // - implicits: 암묵 옵션(접두/접미와 별개)
  // - tags     : affix 태그 매칭용
  // - weaponType: 아이콘/밸런스용 타입 (2h_sword/2h_axe/2h_mace/staff/warstaff)
  // =========================================================

  /* ======================================================= */
  /* WEAPON — Two-Handed Sword (양손검) */
  /* ======================================================= */
  { id:"rusted_greatsword", slot:"weapon", name:"녹슨 대검", baseTier:1, minIlvl:1,  weight:120, weaponType:"2h_sword",
    tags:["weapon","attack","physical","melee","twohand","sword"],
    baseData:{ dmgMul:1.10, spdMul:0.92, rangeMul:1.06, critChanceAdd:0.005 },
    implicits:[ { stat:"critChanceAdd", value:0.010, text:"치명타 확률 +1%" } ],
    descGen:(d)=>`공격 속도 ${Math.round(((d.spdMul ?? 1)-1)*100)}% / 평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"iron_greatsword", slot:"weapon", name:"철 대검",   baseTier:2, minIlvl:12, weight:95,  weaponType:"2h_sword",
    tags:["weapon","attack","physical","melee","twohand","sword"],
    baseData:{ dmgMul:1.18, spdMul:0.94, rangeMul:1.08, critChanceAdd:0.006 },
    implicits:[ { stat:"dmgMul", value:0.04, op:"more", text:"공격 피해 4% 추가(곱)" } ],
    descGen:(d)=>`공격 속도 ${Math.round(((d.spdMul ?? 1)-1)*100)}% / 평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"steel_greatsword", slot:"weapon", name:"강철 대검", baseTier:3, minIlvl:24, weight:70, weaponType:"2h_sword",
    tags:["weapon","attack","physical","melee","twohand","sword","crit"],
    baseData:{ dmgMul:1.30, spdMul:0.95, rangeMul:1.10, critChanceAdd:0.008 },
    implicits:[ { stat:"critMultiAdd", value:0.10, text:"치명타 피해 +10%" } ],
    descGen:(d)=>`치확 +${Math.round((d.critChanceAdd ?? 0)*100)}% / 치피 +${Math.round((d.critMultiAdd ?? 0)*100)}%`
  },
  { id:"tempered_greatsword", slot:"weapon", name:"담금질 대검", baseTier:4, minIlvl:36, weight:45, weaponType:"2h_sword",
    tags:["weapon","attack","physical","melee","twohand","sword"],
    baseData:{ dmgMul:1.44, spdMul:0.96, rangeMul:1.12, critChanceAdd:0.010 },
    implicits:[ { stat:"spdMul", value:0.04, op:"more", text:"공격 속도 4% 추가(곱)" } ],
    descGen:(d)=>`공격 속도 ${Math.round(((d.spdMul ?? 1)-1)*100)}% / 평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"colossus_greatsword", slot:"weapon", name:"거대 대검", baseTier:5, minIlvl:48, weight:25, weaponType:"2h_sword",
    tags:["weapon","attack","physical","melee","twohand","sword","high_tier"],
    baseData:{ dmgMul:1.62, spdMul:0.98, rangeMul:1.14, critChanceAdd:0.012 },
    implicits:[ { stat:"dmgMul", value:0.06, op:"more", text:"공격 피해 6% 추가(곱)" } ],
    descGen:(d)=>`평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },

  /* ======================================================= */
  /* WEAPON — Two-Handed Axe (양손도끼) */
  /* ======================================================= */
  { id:"rusted_greataxe", slot:"weapon", name:"녹슨 양손도끼", baseTier:1, minIlvl:1,  weight:115, weaponType:"2h_axe",
    tags:["weapon","attack","physical","melee","twohand","axe"],
    baseData:{ dmgMul:1.14, spdMul:0.88, rangeMul:1.05 },
    implicits:[ { stat:"dmgMul", value:0.03, op:"more", text:"공격 피해 3% 추가(곱)" } ],
    descGen:(d)=>`평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"iron_greataxe", slot:"weapon", name:"철 양손도끼", baseTier:2, minIlvl:12, weight:92, weaponType:"2h_axe",
    tags:["weapon","attack","physical","melee","twohand","axe"],
    baseData:{ dmgMul:1.24, spdMul:0.90, rangeMul:1.06 },
    implicits:[ { stat:"critChanceAdd", value:0.008, text:"치명타 확률 +0.8%" } ],
    descGen:(d)=>`치확 +${Math.round((d.critChanceAdd ?? 0)*100)}% / 평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"steel_greataxe", slot:"weapon", name:"강철 양손도끼", baseTier:3, minIlvl:24, weight:68, weaponType:"2h_axe",
    tags:["weapon","attack","physical","melee","twohand","axe"],
    baseData:{ dmgMul:1.38, spdMul:0.91, rangeMul:1.07 },
    implicits:[ { stat:"critMultiAdd", value:0.12, text:"치명타 피해 +12%" } ],
    descGen:(d)=>`치피 +${Math.round((d.critMultiAdd ?? 0)*100)}%`
  },
  { id:"executioner_greataxe", slot:"weapon", name:"처형자의 양손도끼", baseTier:4, minIlvl:36, weight:42, weaponType:"2h_axe",
    tags:["weapon","attack","physical","melee","twohand","axe","elite"],
    baseData:{ dmgMul:1.54, spdMul:0.92, rangeMul:1.08 },
    implicits:[ { stat:"dmgMul", value:0.05, op:"more", text:"공격 피해 5% 추가(곱)" } ],
    descGen:(d)=>`평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"behemoth_greataxe", slot:"weapon", name:"거수의 양손도끼", baseTier:5, minIlvl:48, weight:22, weaponType:"2h_axe",
    tags:["weapon","attack","physical","melee","twohand","axe","high_tier"],
    baseData:{ dmgMul:1.74, spdMul:0.93, rangeMul:1.09 },
    implicits:[ { stat:"dmgMul", value:0.07, op:"more", text:"공격 피해 7% 추가(곱)" } ],
    descGen:(d)=>`평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },

  /* ======================================================= */
  /* WEAPON — Two-Handed Mace (양손철퇴) */
  /* ======================================================= */
  { id:"rusted_greatmace", slot:"weapon", name:"녹슨 양손철퇴", baseTier:1, minIlvl:1,  weight:110, weaponType:"2h_mace",
    tags:["weapon","attack","physical","melee","twohand","mace"],
    baseData:{ dmgMul:1.16, spdMul:0.86, rangeMul:1.03 },
    implicits:[ { stat:"armorAdd", value:6, text:"방어력 +6" } ],
    descGen:(d)=>`공격 속도 ${Math.round(((d.spdMul ?? 1)-1)*100)}% / 평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"iron_greatmace", slot:"weapon", name:"철 양손철퇴", baseTier:2, minIlvl:12, weight:88, weaponType:"2h_mace",
    tags:["weapon","attack","physical","melee","twohand","mace"],
    baseData:{ dmgMul:1.30, spdMul:0.87, rangeMul:1.04 },
    implicits:[ { stat:"maxHpAdd", value:10, text:"최대 체력 +10" } ],
    descGen:(d)=>`최대 체력 +${Math.floor(d.maxHpAdd ?? 0)}`
  },
  { id:"steel_greatmace", slot:"weapon", name:"강철 양손철퇴", baseTier:3, minIlvl:24, weight:64, weaponType:"2h_mace",
    tags:["weapon","attack","physical","melee","twohand","mace"],
    baseData:{ dmgMul:1.46, spdMul:0.88, rangeMul:1.05 },
    implicits:[ { stat:"critMultiAdd", value:0.08, text:"치명타 피해 +8%" } ],
    descGen:(d)=>`치피 +${Math.round((d.critMultiAdd ?? 0)*100)}%`
  },
  { id:"crusher_greatmace", slot:"weapon", name:"분쇄자의 양손철퇴", baseTier:4, minIlvl:36, weight:40, weaponType:"2h_mace",
    tags:["weapon","attack","physical","melee","twohand","mace","boss"],
    baseData:{ dmgMul:1.64, spdMul:0.89, rangeMul:1.06 },
    implicits:[ { stat:"dmgMul", value:0.05, op:"more", text:"공격 피해 5% 추가(곱)" } ],
    descGen:(d)=>`평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"titan_greatmace", slot:"weapon", name:"거인의 양손철퇴", baseTier:5, minIlvl:48, weight:20, weaponType:"2h_mace",
    tags:["weapon","attack","physical","melee","twohand","mace","high_tier"],
    baseData:{ dmgMul:1.86, spdMul:0.90, rangeMul:1.07 },
    implicits:[ { stat:"maxHpAdd", value:18, text:"최대 체력 +18" } ],
    descGen:(d)=>`최대 체력 +${Math.floor(d.maxHpAdd ?? 0)}`
  },

  /* ======================================================= */
  /* WEAPON — Staff (지팡이) */
  /* ======================================================= */
  { id:"ash_staff", slot:"weapon", name:"잿빛 지팡이", baseTier:1, minIlvl:1,  weight:120, weaponType:"staff",
    tags:["weapon","attack","melee","twohand","staff"],
    baseData:{ dmgMul:1.04, spdMul:1.00, rangeMul:1.12 },
    implicits:[ { stat:"rangeMul", value:0.04, op:"more", text:"공격 범위 4% 추가(곱)" } ],
    descGen:(d)=>`공격 범위 ${Math.round(((d.rangeMul ?? 1)-1)*100)}%`
  },
  { id:"oak_staff", slot:"weapon", name:"참나무 지팡이", baseTier:2, minIlvl:12, weight:95, weaponType:"staff",
    tags:["weapon","attack","melee","twohand","staff"],
    baseData:{ dmgMul:1.10, spdMul:1.02, rangeMul:1.14 },
    implicits:[ { stat:"hpRegen", value:0.25, text:"재생 +0.25/s" } ],
    descGen:(d)=>`재생 +${(d.hpRegen ?? 0).toFixed(2)}/s`
  },
  { id:"ebony_staff", slot:"weapon", name:"흑단 지팡이", baseTier:3, minIlvl:24, weight:70, weaponType:"staff",
    tags:["weapon","attack","melee","twohand","staff","crit"],
    baseData:{ dmgMul:1.18, spdMul:1.03, rangeMul:1.16, critChanceAdd:0.008 },
    implicits:[ { stat:"critChanceAdd", value:0.012, text:"치명타 확률 +1.2%" } ],
    descGen:(d)=>`치확 +${Math.round((d.critChanceAdd ?? 0)*100)}%`
  },
  { id:"elder_staff", slot:"weapon", name:"장로의 지팡이", baseTier:4, minIlvl:36, weight:45, weaponType:"staff",
    tags:["weapon","attack","melee","twohand","staff","elemental"],
    baseData:{ dmgMul:1.26, spdMul:1.04, rangeMul:1.18 },
    implicits:[ { stat:"elemDmgMul", value:0.06, op:"more", text:"원소 피해 6% 추가(곱)" } ]
  },
  { id:"astral_staff", slot:"weapon", name:"성운 지팡이", baseTier:5, minIlvl:48, weight:25, weaponType:"staff",
    tags:["weapon","attack","melee","twohand","staff","high_tier"],
    baseData:{ dmgMul:1.34, spdMul:1.05, rangeMul:1.20 },
    implicits:[ { stat:"rangeMul", value:0.06, op:"more", text:"공격 범위 6% 추가(곱)" } ],
    descGen:(d)=>`공격 범위 ${Math.round(((d.rangeMul ?? 1)-1)*100)}%`
  },

  /* ======================================================= */
  /* WEAPON — Warstaff (전쟁지팡이) */
  /* ======================================================= */
  { id:"rusted_warstaff", slot:"weapon", name:"녹슨 전쟁지팡이", baseTier:1, minIlvl:1,  weight:110, weaponType:"warstaff",
    tags:["weapon","attack","melee","twohand","warstaff","staff"],
    baseData:{ dmgMul:1.12, spdMul:0.98, rangeMul:1.12, critChanceAdd:0.006 },
    implicits:[ { stat:"critMultiAdd", value:0.08, text:"치명타 피해 +8%" } ],
    descGen:(d)=>`치피 +${Math.round((d.critMultiAdd ?? 0)*100)}%`
  },
  { id:"iron_warstaff", slot:"weapon", name:"철 전쟁지팡이", baseTier:2, minIlvl:12, weight:88, weaponType:"warstaff",
    tags:["weapon","attack","melee","twohand","warstaff","staff"],
    baseData:{ dmgMul:1.22, spdMul:0.99, rangeMul:1.14, critChanceAdd:0.008 },
    implicits:[ { stat:"dmgMul", value:0.04, op:"more", text:"공격 피해 4% 추가(곱)" } ],
    descGen:(d)=>`평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"steel_warstaff", slot:"weapon", name:"강철 전쟁지팡이", baseTier:3, minIlvl:24, weight:64, weaponType:"warstaff",
    tags:["weapon","attack","melee","twohand","warstaff","staff","crit"],
    baseData:{ dmgMul:1.34, spdMul:1.00, rangeMul:1.16, critChanceAdd:0.010 },
    implicits:[ { stat:"critChanceAdd", value:0.012, text:"치명타 확률 +1.2%" } ],
    descGen:(d)=>`치확 +${Math.round((d.critChanceAdd ?? 0)*100)}%`
  },
  { id:"warlord_warstaff", slot:"weapon", name:"군주의 전쟁지팡이", baseTier:4, minIlvl:36, weight:40, weaponType:"warstaff",
    tags:["weapon","attack","melee","twohand","warstaff","staff","boss"],
    baseData:{ dmgMul:1.48, spdMul:1.01, rangeMul:1.18, critChanceAdd:0.010 },
    implicits:[ { stat:"dmgMul", value:0.05, op:"more", text:"공격 피해 5% 추가(곱)" } ],
    descGen:(d)=>`평타 피해 ${Math.round(((d.dmgMul ?? 1)-1)*100)}%`
  },
  { id:"titan_warstaff", slot:"weapon", name:"거인의 전쟁지팡이", baseTier:5, minIlvl:48, weight:22, weaponType:"warstaff",
    tags:["weapon","attack","melee","twohand","warstaff","staff","high_tier"],
    baseData:{ dmgMul:1.66, spdMul:1.02, rangeMul:1.20, critChanceAdd:0.012 },
    implicits:[ { stat:"critMultiAdd", value:0.12, text:"치명타 피해 +12%" } ],
    descGen:(d)=>`치피 +${Math.round((d.critMultiAdd ?? 0)*100)}%`
  },

  /* ======================================================= */
  /* HELM (투구) */
  /* ======================================================= */
  { id:"leather_cap", slot:"helm", name:"가죽 모자", baseTier:1, minIlvl:1,  weight:120,
    tags:["helm","armor","defense"],
    baseData:{ armorAdd:6 },
    implicits:[ { stat:"maxHpAdd", value:6, text:"최대 체력 +6" } ],
    descGen:(d)=>`방어력 +${Math.floor(d.armorAdd ?? 0)}`
  },
  { id:"iron_helmet", slot:"helm", name:"철 투구", baseTier:2, minIlvl:12, weight:95,
    tags:["helm","armor","defense"],
    baseData:{ armorAdd:14 },
    implicits:[ { stat:"armorAdd", value:6, text:"방어력 +6" } ],
    descGen:(d)=>`방어력 +${Math.floor(d.armorAdd ?? 0)}`
  },
  { id:"soldier_helm", slot:"helm", name:"병사의 투구", baseTier:3, minIlvl:24, weight:70,
    tags:["helm","armor","defense"],
    baseData:{ armorAdd:22 },
    implicits:[ { stat:"critChanceAdd", value:0.006, text:"치명타 확률 +0.6%" } ],
    descGen:(d)=>`치확 +${Math.round((d.critChanceAdd ?? 0)*100)}%`
  },
  { id:"templar_helm", slot:"helm", name:"성기사 투구", baseTier:4, minIlvl:36, weight:45,
    tags:["helm","armor","defense"],
    baseData:{ armorAdd:32 },
    implicits:[ { stat:"allResAdd", value:8, text:"모든 저항 +8%" } ]
  },
  { id:"warlord_helm", slot:"helm", name:"군주의 투구", baseTier:5, minIlvl:48, weight:25,
    tags:["helm","armor","defense","high_tier"],
    baseData:{ armorAdd:44 },
    implicits:[ { stat:"maxHpAdd", value:14, text:"최대 체력 +14" } ],
    descGen:(d)=>`방어력 +${Math.floor(d.armorAdd ?? 0)}`
  },

  /* ======================================================= */
  /* CHEST (갑옷) */
  /* ======================================================= */
  { id:"tattered_armor", slot:"chest", name:"누더기 갑옷", baseTier:1, minIlvl:1,  weight:120,
    tags:["chest","armor","life","defense"],
    baseData:{ maxHpAdd:16 },
    implicits:[ { stat:"hpRegen", value:0.25, text:"재생 +0.25/s" } ],
    descGen:(d)=>`최대 체력 +${Math.floor(d.maxHpAdd ?? 0)}`
  },
  { id:"chainmail", slot:"chest", name:"사슬 갑옷", baseTier:2, minIlvl:12, weight:95,
    tags:["chest","armor","life","defense"],
    baseData:{ armorAdd:16, maxHpAdd:22 },
    implicits:[ { stat:"armorAdd", value:10, text:"방어력 +10" } ],
    descGen:(d)=>`방어력 +${Math.floor(d.armorAdd ?? 0)} / 최대 체력 +${Math.floor(d.maxHpAdd ?? 0)}`
  },
  { id:"scalemail", slot:"chest", name:"비늘 갑옷", baseTier:3, minIlvl:24, weight:70,
    tags:["chest","armor","life","defense"],
    baseData:{ armorAdd:28, maxHpAdd:30 },
    implicits:[ { stat:"maxHpAdd", value:10, text:"최대 체력 +10" } ],
    descGen:(d)=>`최대 체력 +${Math.floor(d.maxHpAdd ?? 0)}`
  },
  { id:"plate_armor", slot:"chest", name:"판금 흉갑", baseTier:4, minIlvl:36, weight:45,
    tags:["chest","armor","life","defense"],
    baseData:{ armorAdd:40, maxHpAdd:40 },
    implicits:[ { stat:"allResAdd", value:10, text:"모든 저항 +10%" } ],
    descGen:(d)=>`최대 체력 +${Math.floor(d.maxHpAdd ?? 0)}`
  },
  { id:"astral_plate", slot:"chest", name:"성운 흉갑", baseTier:5, minIlvl:48, weight:25,
    tags:["chest","armor","life","defense","high_tier"],
    baseData:{ armorAdd:56, maxHpAdd:54 },
    implicits:[ { stat:"allResAdd", value:12, text:"모든 저항 +12%" } ],
    descGen:(d)=>`최대 체력 +${Math.floor(d.maxHpAdd ?? 0)}`
  },

  /* ======================================================= */
  /* RING (반지) */
  /* ======================================================= */
  { id:"iron_ring", slot:"ring", name:"철 반지", baseTier:1, minIlvl:1,  weight:130,
    tags:["ring","jewelry","physical"],
    baseData:{},
    implicits:[ { stat:"physAddedMin", value:1, text:"물리 피해 +1~2" }, { stat:"physAddedMax", value:2 } ]
  },
  { id:"coral_ring", slot:"ring", name:"산호 반지", baseTier:1, minIlvl:1,  weight:120,
    tags:["ring","jewelry","life"],
    baseData:{ maxHpAdd:10 },
    implicits:[ { stat:"maxHpAdd", value:10, text:"최대 체력 +10" } ]
  },
  { id:"paua_ring", slot:"ring", name:"파우아 반지", baseTier:2, minIlvl:12, weight:95,
    tags:["ring","jewelry","regen"],
    baseData:{},
    implicits:[ { stat:"hpRegen", value:0.35, text:"재생 +0.35/s" } ]
  },
  { id:"sapphire_ring", slot:"ring", name:"사파이어 반지", baseTier:2, minIlvl:12, weight:90,
    tags:["ring","jewelry","cold"],
    baseData:{},
    implicits:[ { stat:"coldResAdd", value:18, text:"냉기 저항 +18%" } ]
  },
  { id:"ruby_ring", slot:"ring", name:"루비 반지", baseTier:3, minIlvl:24, weight:75,
    tags:["ring","jewelry","fire"],
    baseData:{},
    implicits:[ { stat:"fireResAdd", value:18, text:"화염 저항 +18%" } ]
  },
  { id:"topaz_ring", slot:"ring", name:"토파즈 반지", baseTier:3, minIlvl:24, weight:75,
    tags:["ring","jewelry","lightning"],
    baseData:{},
    implicits:[ { stat:"lightResAdd", value:18, text:"번개 저항 +18%" } ]
  },
  { id:"amethyst_ring", slot:"ring", name:"자수정 반지", baseTier:4, minIlvl:36, weight:45,
    tags:["ring","jewelry","chaos"],
    baseData:{},
    implicits:[ { stat:"chaosResAdd", value:14, text:"카오스 저항 +14%" } ]
  },
  { id:"two_stone_ring", slot:"ring", name:"투스톤 반지", baseTier:4, minIlvl:36, weight:45,
    tags:["ring","jewelry","elemental"],
    baseData:{},
    implicits:[ { stat:"allResAdd", value:8, text:"모든 저항 +8%" } ]
  },
  { id:"opal_ring", slot:"ring", name:"오팔 반지", baseTier:5, minIlvl:48, weight:25,
    tags:["ring","jewelry","elemental","high_tier"],
    baseData:{},
    implicits:[ { stat:"elemDmgMul", value:0.10, op:"more", text:"원소 피해 10% 추가(곱)" } ]
  },
  { id:"steel_ring", slot:"ring", name:"강철 반지", baseTier:5, minIlvl:48, weight:25,
    tags:["ring","jewelry","physical","high_tier"],
    baseData:{},
    implicits:[ { stat:"physAddedMin", value:2, text:"물리 피해 +2~4" }, { stat:"physAddedMax", value:4 } ]
  }
];



/* =========================================================
   STEP 2) createItemInstance()에서 mods 생성 병행
   - 기존 data/affixData/totalData 로직은 그대로 유지
   - item.tags / item.mods 를 추가로 만들어 둠 (아직 계산에 미사용)
   ========================================================= */

function inferItemTagsFromTemplate(tmpl, baseId){
  const tags = [];
  if(tmpl && tmpl.slot) tags.push(tmpl.slot);
  tags.push("gear");

  // baseId 기반 가벼운 분류(나중에 아이템 DB 확장 시 교체)
  const id = String(baseId||"").toLowerCase();
  if(id.includes("ring")) tags.push("jewelry");
  if(id.includes("dmg") || id.includes("ulti")) tags.push("damage");
  if(id.includes("speed")) tags.push("speed");
  if(id.includes("armor")) tags.push("defense");
  if(id.includes("hp") || id.includes("regen")) tags.push("life");

  // slot 기반 분류
  if(tmpl && tmpl.slot === "weapon") tags.push("attack");
  if(tmpl && (tmpl.slot === "helm" || tmpl.slot === "chest")) tags.push("armor");

  
  // ✅ 템플릿이 tags를 제공하면 같이 합친다
  if(tmpl && Array.isArray(tmpl.tags)){
    for(const t of tmpl.tags) tags.push(t);
  }

  return mergeTags(tags);
}

const MUL_KEYS = Object.freeze(["dmgMul","rangeMul","spdMul","atkSpdMul","critChanceMul","hpMul","armorMul"]);

function keyToModOp(statKey){
  // 현재 아이템 데이터 스키마에서 mul 계열은 "more"로 취급
  return (MUL_KEYS.includes(statKey) ? MOD_OPS.more : MOD_OPS.add);
}

function makeBaseModsFromBaseData(baseId, baseData, itemTags){
  const mods = [];
  if(!baseData) return mods;

  // mul 계열
  for(const k of MUL_KEYS){
    const mul = (baseData[k] ?? 1);
    if(typeof mul === "number" && Math.abs(mul - 1) > 1e-9){
      mods.push({
        id: `base:${baseId}:${k}`,
        source: "base",
        scope: "gear",
        stat: k,
        op: MOD_OPS.more,
        value: (mul - 1),
        requiresAll: itemTags,
        requiresAny: [],
        forbids: []
      });
    }
  }

  // add 계열
  const addKeys = ["armorAdd","maxHpAdd","hpRegen","critChanceAdd","critMultiAdd"];
  for(const k of addKeys){
    const v = (baseData[k] ?? 0);
    if(typeof v === "number" && Math.abs(v) > 1e-9){
      mods.push({
        id: `base:${baseId}:${k}`,
        source: "base",
        scope: "gear",
        stat: k,
        op: MOD_OPS.add,
        value: v,
        requiresAll: itemTags,
        requiresAny: [],
        forbids: []
      });
    }
  }
  return mods;
}

function makeImplicitModsFromTemplate(tmpl, itemTags){
  const mods = [];
  if(!tmpl || !Array.isArray(tmpl.implicits)) return mods;

  for(const imp of tmpl.implicits){
    if(!imp) continue;
    const stat = imp.stat;
    if(!stat) continue;

    // 기본 op는 keyToModOp에 맡김(없으면 add)
    const op = imp.op || keyToModOp(stat) || "add";

    // imp.value 없고, min/max 짝이면 각각 따로 들어올 수 있으니 패스
    if(typeof imp.value !== "number") continue;

    mods.push({
      id: `implicit:${tmpl.id}:${stat}`,
      source: "implicit",
      kind: "implicit",
      stat,
      op,
      value: imp.value,
      label: imp.text || null,
      tier: null,
      baseId: tmpl.id,
      requiresAll: itemTags,
      requiresAny: [],
      forbids: []
    });
  }
  return mods;
}



function makeAffixModFromRoll(roll, itemTags){
  // roll: { kind, affix, tier, value }
  if(!roll || !roll.affix) return null;
  const statKey = roll.affix.group; // 현재 AFFIX_DB는 group을 곧바로 데이터 키로 사용
  if(!statKey) return null;

  const op = keyToModOp(statKey);
  const val = (Number(roll.value) || 0);

  return {
    id: `affix:${roll.kind}:${roll.affix.id}:t${roll.tier}`,
    source: roll.kind,
    scope: "gear",
    stat: statKey,
    op,
    value: (op === MOD_OPS.more ? val : val),
    meta: { tier: roll.tier, name: roll.affix.name, group: roll.affix.group, affixId: roll.affix.id },
    requiresAll: itemTags,
    requiresAny: [],
    forbids: []
  };
}


function buildImplicitMods(item){
  const t = getItemTemplateById(item.baseId || item.id);
  const imps = (t && Array.isArray(t.implicits)) ? t.implicits : [];
  const out = [];
  for(let i=0;i<imps.length;i++){
    const imp = imps[i];
    if(!imp) continue;
    out.push({
      id: (item.baseId || item.id) + "_implicit_" + i,
      source: "implicit",
      scope: imp.scope || "global",
      requiresAll: imp.requiresAll || [],
      requiresAny: imp.requiresAny || [],
      forbids: imp.forbids || [],
      stat: imp.stat,
      op: imp.op,
      value: imp.value,
      stacks: 1,
      enabled: true
    });
  }
  return out;
}

function buildItemMods(baseId, baseData, affixes, itemTags, tmpl=null){
  const mods = [];
  mods.push(...makeBaseModsFromBaseData(baseId, baseData, itemTags));
  mods.push(...makeImplicitModsFromTemplate(tmpl, itemTags));
  if(Array.isArray(affixes)){
    for(const a of affixes){
      const m = makeAffixModFromRoll(a, itemTags);
      if(m) mods.push(m);
    }
  }
  return mods;
}
// =========================================================
// STEP 4) affix.apply → mods 기반 데이터 생성(점진 이관)
// - AFFIX_DB.apply는 당분간 유지(호환)
// - 아이템 data/affixData/totalData 생성만 mods로 대체 시작
// =========================================================
const USE_MODS_FOR_ITEMDATA = true;

function buildDataFromMods(mods, { includeBase=true } = {}){
  // mods -> makeEmptyItemData 형태로 환원 (UI/descGen용)
  const d = makeEmptyItemData();
  if(!Array.isArray(mods)) return d;

  for(const m of mods){
    if(!m || m.scope !== "gear") continue;
    if(!includeBase && (m.source === "base" || m.source === "implicit")) continue;

    const k = m.stat;
    if(!k) continue;

    if(m.op === MOD_OPS.more){
      const cur = (typeof d[k] === "number" ? d[k] : 1);
      d[k] = cur * (1 + (Number(m.value) || 0));
    }else{
      const cur = (typeof d[k] === "number" ? d[k] : 0);
      d[k] = cur + (Number(m.value) || 0);
    }
  }
  return d;
}

function buildAffixDataFromMods(mods){
  return buildDataFromMods(mods, { includeBase:false });
}


/* ============================= */
/* ✅ POE식 이름 생성 (접두/접미, 레어 이름) */
/* ============================= */
// ✅ 중복 로드/중복 선언에도 안전하게 (const 금지)
var RARE_NAME_A = window.RARE_NAME_A || (window.RARE_NAME_A = [
  "망령","암흑","피의","폭풍","철","그림자","공허","파멸","서리","번개","잔혹","광기의","망각","귀신","지옥","죽음","칠흑","부패","독","지배"
]);

var RARE_NAME_B = window.RARE_NAME_B || (window.RARE_NAME_B = [
  "약탈자","학살자","송곳니","칼날","발톱","수호자","징표","심장","파수꾼","파괴자","사냥꾼","추적자","심연","망치","창","검","방패","의지","서약","파멸"
]);
function randPick(arr){ return arr[(Math.random()*arr.length)|0]; }
function rollRareName(){ return randPick(RARE_NAME_A) + " " + randPick(RARE_NAME_B); }

function normalizeRarity(r){
  // ✅ Legacy → New (안전 매핑)
  if(r === "magic") return "magic";
  if(r === "rare") return "rare";
  if(r === "unique") return "unique";

  // ✅ Supported set
  if(r === "normal" || r === "magic" || r === "rare" || r === "unique") return r;

  // ✅ Fallback (unknown)
  return "normal";
}



function createItemInstance(baseId, rarityOverride=null, opts=null){
  // ✅ 안전: 존재하지 않는 baseId가 들어와도 크래시 안 나게 fallback
  let tmpl = getItemTemplateById(baseId);
  if(!tmpl){
    console.warn("Invalid baseId:", baseId);
    const pool = Array.isArray(ITEM_POOL) ? ITEM_POOL : [];
    tmpl = pool.find(x => x && x.slot === "weapon") || pool[0] || null;
    if(!tmpl) return null;
    baseId = tmpl.id;
  }

  const rarity = normalizeRarity(rarityOverride || tmpl.rarity || "normal");
  const ilvl = Math.max(((opts && opts.ilvl)!=null ? opts.ilvl : getItemLevel()), (tmpl.minIlvl ?? 1));

  // ✅ 기존 로직(베이스/접사 데이터 계산) 유지
  const baseData = buildBaseDataFromItemId(baseId);

  // ✅ tags 먼저 산출 → 태그 기반 affix 선택 가능
  const tags = inferItemTagsFromTemplate(tmpl, baseId);

  const affixes = rollAffixesPOE(rarity, ilvl, tags, { tmpl, baseId });

  // ✅ STEP2: tags/mods 병행 생성
  const mods = buildItemMods(baseId, baseData, affixes, tags, tmpl);

  // ✅ STEP4: affix.apply 대신 mods로 affixData 생성(점진 이관)
  const affixData = USE_MODS_FOR_ITEMDATA
    ? buildAffixDataFromMods(mods)
    : (function(){
        const d = makeEmptyItemData();
        for(const a of affixes){
          if(a && a.affix && typeof a.affix.apply === "function") a.affix.apply(d, a.value);
        }
        return d;
      })();

  const totalData = mergeItemData(baseData, affixData);

  const preNames = affixes.filter(x=>x.kind==="prefix").map(x=>x.affix.name);
  const sufNames = affixes.filter(x=>x.kind==="suffix").map(x=>x.affix.name);

  // ✅ POE 스타일:
  // - 일반(매직): 첫 prefix/첫 suffix만 이름에 반영
  // - 레어/에픽: 접두/접미를 이름에서 제거하고, 랜덤 레어명 부여
  let nm = tmpl.name;
  if(rarity === "magic"){
    const pre = preNames[0] || "";
    const suf = sufNames[0] || "";
    if(pre) nm = pre + " " + nm;
    if(suf) nm = nm + " " + suf;
  }else if(rarity === "rare"){
    nm = rollRareName();
  }

  return {
    id: baseId,
    baseId,
    baseName: tmpl.name,
    baseTier: (tmpl.baseTier ?? 1),
    implicits: Array.isArray(tmpl.implicits) ? tmpl.implicits : [],
    name: nm,
    rarity,
    slot: tmpl.slot,
    ilvl,
    isUnique: false,

    // ✅ 기존 필드들
    data: totalData,
    totalData,
    baseData,
    affixData,
    affixes,
    shownDesc: tmpl.descGen ? tmpl.descGen(totalData) : "",

    // ✅ 신규 필드(모드 엔진용)
    tags,
    mods
  };
}


function giveStarterItems(){
  // ✅ 베이스 풀 기반 스타터 지급 (베이스가 바뀌어도 안 터짐)
  const pool = Array.isArray(ITEM_POOL) ? ITEM_POOL : [];
  const pickBySlot = (slot)=>{
    return pool.find(x=>x && x.slot===slot && ((x.baseTier ?? 1) <= 1)) ||
           pool.find(x=>x && x.slot===slot) || null;
  };

  const starters = [
    pickBySlot("weapon"),
    pickBySlot("chest"),
    pickBySlot("ring"),
    pickBySlot("boots")
  ].filter(Boolean);

  for(const t of starters){
    const it = createItemInstance(t.id, "normal");
    if(it) inventory.push(it);
  }
}

/* ============================= */
/* ✅ 전설(Unique) 시스템         */
/* ============================= */
let ownedUniques = [];
let uniqueState = {};

function emitEvent(type, payload){
  for(const u of ownedUniques){
    if(u.onEvent) u.onEvent(type, payload);
  }
}
function cloneLegendary(template){
  return {
    id: template.id,
    name: template.name,
    rarity: template.rarity ?? "legendary",
    desc: template.desc ?? "",
    applyStat: template.applyStat,
    onEvent: template.onEvent,
  };
}

function acquireLegendary(template, ilvl){
  if(ownedUniques.some(u => u.id === template.id)){
    shake = Math.max(shake, 6);
    return;
  }
  const u = cloneLegendary(template);
  if(u.applyStat) u.applyStat();
  ownedUniques.push(u);

  inventory.push({
    id: u.id,
    slot: "unique",
    name: u.name,
    rarity:"unique",
    ilvl,
    isUnique: true,
    uniqueRef: u,
    data: null,
    affixes: []
  });

  recalcFromGear();
}

const LEGENDARY_POOL = [
  {
    id:"unique_thunderstep",
    name:"천둥걸음 (Thunderstep)",
    rarity:"unique",
    desc:"적 처치 시 번개가 주변으로 연쇄 (쿨 0.8초)",
    applyStat(){ applyGearDelta({ dmgMul: 1.10 }); },
    onEvent(type, p){
      if(type !== "kill") return;

      const now = frameCount;
      const key = this.id + "_cd";
      const cd = uniqueState[key] ?? 0;
      if(now < cd) return;
      uniqueState[key] = now + 48;

      const cx = p.x, cy = p.y;
      let hits = 0;

      for(const e of enemies){
        if(e.hp <= 0) continue;
        if(e.type === "boss" && e.dead) continue;

        const dx = e.x - cx, dy = e.y - cy;
        if(dx*dx + dy*dy > 200*200) continue;

        const ctxChain = buildCombatCtx("lightning_chain", e);
        const chainRes = computeFinalDamage(baseDamage * 0.65, ctxChain, { canCrit:false });
        e.hp -= chainRes.dealt;
        spawnHitBlood(e.x, e.y, 8);

        if(particles.length < 260){
          for(let i=0;i<6;i++){
            particles.push({ x:e.x, y:e.y, vx:(Math.random()-0.5)*6, vy:(Math.random()-0.5)*6, life:18 });
          }
        }
        hits++;
        if(hits >= 4) break;
      }
      pruneDeadEnemies();
    }
  },
  {
    id:"unique_oni_aegis",
    name:"오니의 수호 (Oni Aegis)",
    rarity:"unique",
    desc:"피격 시 보호막 1회 생성 (피해 35% 감소 느낌, 2초, 쿨 6초)",
    applyStat(){
      player.baseArmor += 4;
      player.baseMaxHp += 20;
      player.hp += 20;
    },
    onEvent(type, p){
      if(type !== "takeDamage") return;
      const now = frameCount;
      const cdKey = this.id + "_cd";
      if((uniqueState[cdKey] ?? 0) > now) return;

      applyBuff(player, "armor", 30, 120, "oni_aegis", "add");
      uniqueState[cdKey] = now + 360;

      shake = Math.max(shake, 12);
      for(let i=0;i<22;i++){
        particles.push({ x:player.x, y:player.y, vx:(Math.random()-0.5)*8, vy:(Math.random()-0.5)*8, life:22 });
      }
    }
  },
  {
    id:"unique_bloodkatana",
    name:"혈귀의 도 (Blood Katana)",
    rarity:"unique",
    desc:"타격 시 20% 확률로 출혈 장판 생성(3초). 장판은 초당 피해 + 흡혈",
    applyStat(){
      baseDamageBase *= 1.08;
      recalcFromGear();
    },
    onEvent(type, p){
      if(type !== "hit") return;
      if(Math.random() > 0.20) return;

      const x = p.enemy.x;
      const y = p.enemy.y;

      fireZones.push({
        x, y,
        radius:60,
        life:180,
        tick:0,
        damage: Math.max(2, baseDamage * 0.18),
        isBleed:true
      });
    }
  }
];

function rollRarity(){
  const t = mapTier;

  // PoE 느낌: unique(아주 낮음) / rare / magic / normal
  const uniqueP = clamp(0.004 + (t-1)*0.00035, 0.004, 0.020);
  const rareP   = clamp(0.055 + (t-1)*0.0020, 0.055, 0.140);
  const magicP  = clamp(0.240 + (t-1)*0.0060, 0.240, 0.420);

  const r = Math.random();
  if(r < uniqueP) return "unique";
  if(r < uniqueP + rareP) return "rare";
  if(r < uniqueP + rareP + magicP) return "magic";
  return "normal";
}


function pickItemsForChoice(count){

  // ✅ mapTier는 전역 변수(mapTier)를 사용 (Game 미정의로 인한 ReferenceError 방지)
  const mapTier = Math.max(1,
    (typeof globalThis!=="undefined" && typeof globalThis.mapTier==="number")
      ? globalThis.mapTier
      : 1
  );
  if(!Array.isArray(ITEM_POOL) || ITEM_POOL.length === 0){
    console.warn("ITEM_POOL empty");
    return [];
  }

  // helpers may not exist in some builds; provide safe fallbacks
  const safePickSlot = (typeof pickSlotForMapTier === "function")
    ? pickSlotForMapTier
    : (t)=> "weapon";

  const safePickBaseTier = (typeof pickBaseTierForMap === "function")
    ? pickBaseTierForMap
    : (t)=> t;

  const safeRollIlvl = (typeof rollItemLevelFromMapTier === "function")
    ? rollItemLevelFromMapTier
    : (t)=> Math.max(1, t*5);

  const results = [];
  const usedBaseIds = new Set();

  for(let i=0;i<count;i++){

    let slot = null;
    try { slot = safePickSlot(mapTier); } catch(e){ slot = null; }
    if(!slot) slot = "weapon";

    let pool = ITEM_POOL.filter(b => b && b.slot === slot);
    if(!pool.length) pool = ITEM_POOL.filter(b => b) || [];

    if(!pool.length){
      console.warn("No base pool for slot:", slot);
      continue;
    }

    let targetTier = null;
    try { targetTier = safePickBaseTier(mapTier); } catch(e){ targetTier = null; }
    if(!targetTier) targetTier = mapTier;

    let filtered = pool.filter(b => (b.baseTier ?? 1) <= targetTier);
    if(!filtered.length) filtered = pool;

    // build weighted list safely (cap expansion)
    const weighted = [];
    const CAP = 3000;
    for(const b of filtered){
      if(!b) continue;
      const w = Math.max(1, Math.floor(b.weight ?? 100));
      for(let k=0;k<w && weighted.length < CAP;k++){
        weighted.push(b);
      }
      if(weighted.length >= CAP) break;
    }

    if(!weighted.length){
      console.warn("Weighted empty for slot:", slot, "tier:", targetTier);
      continue;
    }

    let choice = null;
    for(let t=0;t<7;t++){
      const cand = weighted[Math.floor(Math.random()*weighted.length)];
      if(cand && cand.id && !usedBaseIds.has(cand.id)){
        choice = cand;
        break;
      }
    }
    if(!choice){
      const cand = weighted[Math.floor(Math.random()*weighted.length)];
      if(cand && cand.id) choice = cand;
    }
    if(!choice || !choice.id){
      console.warn("No choice resolved");
      continue;
    }

    usedBaseIds.add(choice.id);

    const ilvl = Math.max(1, safeRollIlvl(mapTier));

    let item = null;
    try{
      // createItemInstance signature differs across builds; support both
      if(typeof createItemInstance === "function"){
        item = createItemInstance(choice.id, null, { ilvl });
      }
    }catch(e){
      console.warn("createItemInstance failed:", e);
      item = null;
    }

    if(item) results.push(item);
  }

  
  // ✅ 안전장치: 어떤 이유로든 결과가 비면 최소 1개는 강제로 생성
  if(results.length === 0){
    try{
      const fallback = (Array.isArray(ITEM_POOL) && ITEM_POOL.length) ? ITEM_POOL[Math.floor(Math.random()*ITEM_POOL.length)] : null;
      if(fallback && fallback.id && typeof createItemInstance==="function"){
        const ilvl = Math.max(1, safeRollIlvl(mapTier));
        const it = createItemInstance(fallback.id, null, { ilvl });
        if(it) results.push(it);
      }
    }catch(e){ /* ignore */ }
  }
return results;
}


function spawnLoot(x, y, source="mob"){
  if(loots.length > 25) loots.splice(0, loots.length-25);
const choices = pickItemsForChoice(3);
if(!choices || !choices.length){
  console.warn("No items rolled");
  return;
}
loots.push({ x, y, r: 14, ttl: 60*45, choices, taken: false, source });
}

function getNearbyLoot(){
  for(const L of loots){
    if(L.taken) continue;
    const dx = L.x - player.x;
    const dy = L.y - player.y;
    const rr = (L.r + player.radius + 18);
    if(dx*dx + dy*dy <= rr*rr) return L;
  }
  return null;
}

function openLootChoice(L){
  if(!L || L.taken) return;
  pauseGame({ dim: 0.60, blur: 2 });
  overlayPush();
  lootOverlayOpen = true;
  pendingLoot = L;

  lootOverlay.style.display = "flex";
  lootCardsEl.innerHTML = "";

  L.choices.forEach((it)=>{
    const card = document.createElement("div");
    card.className = `lootCard ${normalizeRarity(it.rarity)}`;

    const ilvl = getItemLevel();
    const pick = { it, ilvl };

    if(normalizeRarity(it.rarity) === "unique"){
      pick.kind = "unique";
      pick.shownName = it.name;
      pick.shownDesc = it.desc;
    }else{
      pick.kind = "normal";
      pick.baseData = buildBaseDataFromItemId(it.id);
      pick.tags = inferItemTagsFromTemplate(it, it.id);
      pick.affixes = rollAffixesPOE(it.rarity, ilvl, pick.tags);

      // ✅ STEP2/4: tags/mods + mods 기반 데이터 생성
      pick.mods = buildItemMods(it.id, pick.baseData, pick.affixes, pick.tags);

      const affixData = USE_MODS_FOR_ITEMDATA
        ? buildAffixDataFromMods(pick.mods)
        : (function(){
            const d = makeEmptyItemData();
            for(const a of pick.affixes){ if(a && a.affix && typeof a.affix.apply === "function") a.affix.apply(d, a.value); }
            return d;
          })();

      pick.affixData = affixData;
      pick.totalData = mergeItemData(pick.baseData, pick.affixData);

      const preNames = pick.affixes.filter(x=>x.kind==="prefix").map(x=>x.affix.name);
      const sufNames = pick.affixes.filter(x=>x.kind==="suffix").map(x=>x.affix.name);

      pick.baseName = it.name;
      pick.baseId = it.id;

      let nm = pick.baseName;
      if(preNames.length) nm = preNames.join(" ") + " " + nm;
      if(sufNames.length) nm = nm + " " + sufNames.join(" ");
      pick.name = nm;

      pick.shownName = pick.name;
      pick.shownDesc = it.descGen ? it.descGen(pick.totalData) : (it.desc || "");
    }

    const rKey = normalizeRarity(it.rarity);

card.innerHTML = `
  <div class="name rName r-${rKey}">${pick.shownName}</div>
  <div class="desc">${pick.shownDesc}</div>
  <button type="button">이걸 선택</button>
`;

    card.querySelector("button").addEventListener("click", ()=>{
      if(pick.kind === "unique"){
        acquireLegendary(pick.it, pick.ilvl);
      } else {
        const chosen = {
          id: pick.baseId,
          baseId: pick.baseId,
          baseName: pick.baseName,
          name: pick.name,
          rarity: pick.it.rarity,
          slot: pick.it.slot,
          ilvl: pick.ilvl,
          isUnique: false,
          data: pick.totalData,
          totalData: pick.totalData,
          baseData: pick.baseData,
          affixData: pick.affixData,
          affixes: pick.affixes,
          shownDesc: pick.shownDesc
        };
        inventory.push(chosen);
        if(panelOpen) renderAllPanels();
      }
      L.taken = true;
      closeLootChoice();
      shake = Math.max(shake, 10);
    });

    lootCardsEl.appendChild(card);
  });
}

function closeLootChoice(){
  lootOverlayOpen = false;
  pendingLoot = null;
  lootOverlay.style.display = "none";
  overlayPop();
  resumeGame();
}

function updateLoots(){
  for(let i=loots.length-1;i>=0;i--){
    const L = loots[i];
    if(L.taken){ loots.splice(i,1); continue; }
    L.ttl--;
    if(L.ttl <= 0) loots.splice(i,1);
  }
}
function drawLoots(){
  if(loots.length === 0) return;

  ctx.save();
  for(const L of loots){
    if(L.taken) continue;

    const pulse = 0.5 + 0.5*Math.sin(frameCount*0.15);
    ctx.globalAlpha = 0.75 + pulse*0.25;

    ctx.fillStyle = "rgba(80,140,255,0.25)";
    ctx.beginPath();
    ctx.arc(L.x, L.y, L.r + 10 + pulse*6, 0, Math.PI*2);
    ctx.fill();

    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "rgba(40,120,255,0.9)";
    ctx.beginPath();
    ctx.arc(L.x, L.y, L.r, 0, Math.PI*2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", L.x, L.y+1);
  }
  ctx.restore();
}

/* ============================= */
/* ✅ POE식 장비 슬롯 / 인벤토리  */
/* ============================= */
const EQUIP_SLOTS = ["weapon","helm","chest","ring"];
let equipment = { weapon:null, helm:null, chest:null, ring:null };

let inventory = [];
let selectedInvIndex = -1;

let transmuteOrbs = 6;   // 변환의 오브
let alterationOrbs = 10; // 변화의 오브
let augmentationOrbs = 6;// 증강의 오브
let regalOrbs = 3;       // 제왕의 오브
let alchemyOrbs = 3;     // 연금술사의 오브
let chaosOrbs = 2;       // 카오스의 오브
let scouringOrbs = 3;    // 세공의 오브
let exaltedOrbs = 1;     // 승격의 오브
let annulOrbs = 1;       // 소멸의 오브
let divineOrbs = 1;      
let corruptOrbs = 5;
// 신성한 오브


let orbUIState = { cx:0, cy:0, centerR:24, ready:false };
let particles=[];
let bloodPools=[];
let shake=0;
let xp = 0;
let xpToNext = 120;
let level = 1;
let gameOver = false;
let orbFlash = 0;
let flashEffect = 0;

let baseDamageBase = 20;
let ultiDamageBase = 40;

let baseDamage = baseDamageBase;
let ultiDamage = ultiDamageBase;

player.gear = {
  dmgMul: 1,
  spdMul: 1,
  atkSpdMul: 1,
  rangeMul: 1,
  armorAdd: 0,
  maxHpAdd: 0,
  hpRegen: 0,
  critChanceAdd: 0,
  critChanceMul: 1,
  critMultiAdd: 0,
};


/* =========================================================
   STEP 3) recalcFromGear()에서 mods 기반 계산 레이어 추가
   - item.data(기존)와 별개로 item.mods 를 이용해 gearDelta를 만들어 applyGearDelta에 주입
   - 나중에 affix.apply → mods 생성으로 완전 이관하기 위한 발판
   - 혹시 스탯이 이상하면 아래 플래그를 false로 바꾸면 즉시 원복됨
   ========================================================= */
const USE_GEAR_MODS_LAYER = true;

function gearTagsFromItem(it){
  const tags = [];
  if(it && it.slot) tags.push(it.slot);
  if(it && Array.isArray(it.tags)) tags.push(...it.tags);
  tags.push("gear");
  return mergeTags(tags);
}

function gearDeltaFromMods(modList, ctx){
  const out = {};
  if(!Array.isArray(modList) || modList.length === 0) return out;

  const mctx = {
    scope: (ctx && ctx.scope) ? ctx.scope : "gear",
    tags:  (ctx && ctx.tags)  ? ctx.tags  : []
  };

  for(const m of modList){
    if(!m) continue;

    // 태그/스코프 매칭 (엔진 공통 규칙)
    if(typeof modMatches === "function" && !modMatches(m, mctx)) continue;

    const k = m.stat;
    if(!k) continue;

    const op = m.op || MOD_OPS.add;
    const v  = (Number(m.value) || 0);

    if(op === MOD_OPS.add){
      out[k] = (out[k] || 0) + v;
    }else if(op === MOD_OPS.inc){
      // gear 쪽은 Inc 키를 쓰는 경우가 많아서, kInc 형태로 넣어둠
      const kk = (String(k).endsWith("Inc") ? k : (k + "Inc"));
      out[kk] = (out[kk] || 0) + v;
    }else if(op === MOD_OPS.more){
      const mul = 1 + v;
      out[k] = (out[k] || 1) * mul;
    }
  }
  return out;
}


function recalcFromGear(){
  // ✅ 전체를 다시 계산(안정화): 장비/버프 누적 → 최종 스탯 반영
  player.gear = defaultBuffStats();

  // 1) 장비 누적
  for(const slot of EQUIP_SLOTS){
    const it = equipment[slot];
    if(!it) continue;

    // ✅ STEP3: mods 기반 레이어 (기존 data 로직은 유지한 채로 선택 사용)
    if(USE_GEAR_MODS_LAYER && Array.isArray(it.mods) && it.mods.length){
      const tags = gearTagsFromItem(it);
      const d2 = gearDeltaFromMods(it.mods, { scope:"gear", tags });
      if(d2) applyGearDelta(d2);
      continue;
    }

    // totalData 우선, 없으면 data 사용
    const d = it.totalData || it.data || null;
    if(!d) continue;

    applyGearDelta(d);
  }

  // 2) 최종 출력값 계산 (POE식)
  const g = player.gear;

  g.dmgMul    = (1 + (g.dmgInc || 0))    * (g.dmgMore    || 1);
  g.atkSpdMul = (1 + (g.atkSpdInc || 0)) * (g.atkSpdMore || 1);
  g.spdMul    = (1 + (g.spdInc || 0))    * (g.spdMore    || 1);
  g.rangeMul  = (1 + (g.rangeInc || 0))  * (g.rangeMore  || 1);

  // 3) 플레이어 기본 능력치에 반영
  const baseMaxHp = (player.baseMaxHp ?? 100);
  const baseArmor = (player.baseArmor ?? 0);

  player.maxHp = baseMaxHp + (g.maxHpAdd || 0);
  player.armor = baseArmor + (g.armorAdd || 0);

  // 현재 HP가 max를 넘지 않게
  if(player.hp > player.maxHp) player.hp = player.maxHp;
}

function applyGearDelta(d){
  // ✅ 장비/버프 스탯 누적 (POE식)
  if(!d) return;
  if(!player.gear) player.gear = defaultBuffStats();

  const g = player.gear;

  // 1) 기존(Add) 고정값
  if(d.maxHpAdd) g.maxHpAdd += d.maxHpAdd;
  if(d.armorAdd) g.armorAdd += d.armorAdd;
  if(d.hpRegen)  g.hpRegen  += d.hpRegen;

  // 2) increased(Inc) / more(Mul) — 없으면 무시
  // 피해
  if(d.dmgInc) g.dmgInc += d.dmgInc;
  if(d.dmgMul) g.dmgMore *= d.dmgMul;

  // 공격속도
  if(d.atkSpdInc) g.atkSpdInc += d.atkSpdInc;
  if(d.atkSpdMul) g.atkSpdMore *= d.atkSpdMul;

  // 이동속도
  if(d.spdInc) g.spdInc += d.spdInc;
  if(d.spdMul) g.spdMore *= d.spdMul;

  // 사거리
  if(d.rangeInc) g.rangeInc += d.rangeInc;
  if(d.rangeMul) g.rangeMore *= d.rangeMul;

  // 치명타 확률/배수
  if(d.critChanceAdd) g.critChanceAdd += d.critChanceAdd;
  if(d.critChanceInc) g.critChanceInc += d.critChanceInc;
  if(d.critChanceMul) g.critChanceMore *= d.critChanceMul;

  if(d.critMultiAdd) g.critMultiAdd += d.critMultiAdd;
  if(d.critMultiInc) g.critMultiInc += d.critMultiInc;
}

let levelParticles = [];
let arrows = [];
let bloodParticles = [];
let fireZones = [];
let frameCount = 0;

let killCount = 0;
let killsAtLevelStart = 0;
let killsForNextLevel = 20;
let explosionActive = false;
let bossSpawned = false;
let bossTimer = 0;
let bossInterval = 45 * 60;

let mapTier = 1;
let mapSeed = 0;
let mapRun = {
  tier: 1,
  seed: 0,
  packsToClear: 10,
  clearedPacks: 0,
  bossSpawned: false,
  bossDefeated: false,
};

let portal = {
  active: false,
  x: 0,
  y: 0,
  r: 32,
  hold: 0,
  holdNeed: 25
};
let bossRoom = { x:0, y:0, w:0, h:0, cx:0, cy:0, doorX:0, doorY:0 };

/* ===== 입력 ===== */
let joyDX=0, joyDY=0;
// (v2) attacking state moved near input adapter
let attackFrame=0;
let keys = {};

window.addEventListener("keydown", e=>{ keys[e.key] = true; });
window.addEventListener("keyup", e=>{ keys[e.key] = false; });


  // ===== 입력 (v2: UI에서 들어오는 입력만 받음) =====
  // UI는 아래 API를 호출해서 입력을 전달한다:
  //   Game.setJoy(dx,dy)   (-1~1)
  //   Game.setAttack(on)   (true/false)
  //   Game.pressLoot()     (loot 버튼)
  let joyDX = 0, joyDY = 0;
  let attacking = false;

  function clamp1(v){ return Math.max(-1, Math.min(1, v)); }

  function setJoy(dx, dy){
    joyDX = clamp1(dx||0);
    joyDY = clamp1(dy||0);
  }

  function setAttack(on){
    attacking = !!on;
  }

  function pressLoot(){
    try{
      if(typeof getNearbyLoot === "function"){
        const near = getNearbyLoot();
        if(!near) return;
        if(typeof openLootChoice === "function") openLootChoice(near);
      }
    }catch(_){}
  }
},{passive:true});

/* ===== 유틸 ===== */
function rollWeaponDamage(){
  const w = player.weapon;
  return w.min + Math.random() * (w.max - w.min);
}

function getCritChance(){
  // 기본치 + Add → increased → more
  const g = player.gear || {};
  const base = (player.baseCritChance ?? 0.05); // 5% 기본
  const add = (g.critChanceAdd || 0);
  const inc = (g.critChanceInc || 0);
  const more = (g.critChanceMore || 1);
  return Math.max(0, (base + add) * (1 + inc) * more);
}
function getCritMulti(){
  // 기본치 + Add → increased → more
  const g = player.gear || {};
  const base = (player.baseCritMulti ?? 1.50); // x1.50 기본
  const add = (g.critMultiAdd || 0);
  const inc = (g.critMultiInc || 0);
  const more = (g.critMultiMore || 1);
  return Math.max(1, (base + add) * (1 + inc) * more);
}
function applyCrit(dmg){
  const chance = getCritChance();
  const multi = getCritMulti();
  const isCrit = (Math.random() < chance);
  return { dmg: isCrit ? dmg * multi : dmg, isCrit, chance, multi };
}

function defaultBuffStats(){
  // ✅ POE식(기본 + 증가(increased) + 추가배율(more))를 내부에서 지원
  // - Add : 고정 수치(+)   예) maxHpAdd, armorAdd, hpRegen
  // - Inc : 증가(%)        예) dmgInc = 0.15  (15% increased)
  // - Mul : 추가 배율(x)   예) dmgMul = 1.20  (20% more)
  return {
    maxHpAdd: 0,
    armorAdd: 0,
    hpRegen: 0,

    // 피해/속도/이동/사거리 (POE식)
    dmgInc: 0,     dmgMore: 1,
    atkSpdInc: 0,  atkSpdMore: 1,
    spdInc: 0,     spdMore: 1,
    rangeInc: 0,   rangeMore: 1,

    // 치명타 (POE식)
    critChanceAdd: 0,
    critChanceInc: 0,
    critChanceMore: 1,

    critMultiAdd: 0,
    critMultiInc: 0,
    critMultiMore: 1,

    // 🔻 최종 출력(아래 recalcFromGear에서 채움)
    dmgMul: 1,
    atkSpdMul: 1,
    spdMul: 1,
    rangeMul: 1,
  };
}

function applyBuff(target, type, value, duration, source="", mode="mul"){
  if(!target.activeBuffs) target.activeBuffs = [];
  const key = type + "|" + source + "|" + mode;
  const b = target.activeBuffs.find(x => x.key === key);

  if(b){
    b.value = value;
    b.duration = Math.max(b.duration, duration);
  }else{
    target.activeBuffs.push({ key, type, value, duration, mode });
  }
}

function mapBuffTypeToStat(type){
  if(type === "damage")   return "dmgMul";
  if(type === "speed")    return "spdMul";
  if(type === "atkSpeed") return "atkSpdMul";
  if(type === "range")        return "rangeMul";
  if(type === "meleeRange")   return "meleeRangeMul";
  if(type === "aoe")          return "aoeMul";
  if(type === "ultiAoe")      return "ultiAoeMul";
  if(type === "armor")        return "armorAdd";
  if(type === "armorMul")     return "armorMul";
  if(type === "maxHpMul")     return "maxHpMul";
  if(type === "maxHp")        return "maxHpAdd";
  if(type === "hpRegen")      return "hpRegen";
  return null;
}

function updateBuffs(target){
  if(!target.activeBuffs) target.activeBuffs = [];
  target.buffs = defaultBuffStats();

  if(target === player){
    target.buffs.dmgMul   *= (player.gear.dmgMul ?? 1);
    target.buffs.rangeMul *= (player.gear.rangeMul ?? 1);
    target.buffs.spdMul    *= (player.gear.spdMul ?? 1);
    target.buffs.atkSpdMul *= (player.gear.atkSpdMul ?? 1);
    target.buffs.armorAdd += (player.gear.armorAdd ?? 0);
    target.buffs.maxHpAdd += (player.gear.maxHpAdd ?? 0);
    target.buffs.hpRegen  += (player.gear.hpRegen ?? 0);
  }

  for(let i = target.activeBuffs.length - 1; i >= 0; i--){
    const b = target.activeBuffs[i];
    b.duration--;
    if(b.duration <= 0){
      target.activeBuffs.splice(i,1);
      continue;
    }
    const stat = mapBuffTypeToStat(b.type);
    if(!stat) continue;

    if(b.mode === "mul"){
      if(target.buffs[stat] !== undefined) target.buffs[stat] *= b.value;
    }else if(b.mode === "add"){
      if(target.buffs[stat] !== undefined) target.buffs[stat] += b.value;
    }
  }

  if(target === player){
    const b = target.buffs;
    const newMax = Math.max(1, Math.floor(target.baseMaxHp * (b.maxHpMul ?? 1) + (b.maxHpAdd ?? 0)));
    target.maxHp = newMax;
    if(target.hp > target.maxHp) target.hp = target.maxHp;
    target.armor = Math.max(0, (target.baseArmor + (b.armorAdd ?? 0)) * (b.armorMul ?? 1));
  }
}

/* ===== 여기 아래는 너가 올려준 원본 로직 그대로(맵/몹/전투/렌더) ===== */
/* NOTE: 블랙스크린 원인(구 인벤 마크업 + CSS 깨짐 + prettyItemText 줄바꿈 버그)을 제거/수정했음.
   아래 로직은 너무 길어서 생략하지 않고 그대로 이어져야 함. */

/* ---------------------------------------------------------------------- */
/* 너가 올린 코드에서 여기 이후(맵 생성/몬스터/렌더/패널 로직/loop/resetGame)
   는 그대로 붙여넣되, 아래 두 가지만 꼭 적용돼 있어야 해:

   ✅ 1) 'prettyItemText' 마지막 return:
      return lines.join("\\n");

   ✅ 2) 구버전 인벤 HTML 블록( invHeaderSub ~ invHint )은 아예 없음.

   이 파일은 블랙스크린 원인 제거용 “정리본 템플릿”이야.
   너가 원본 코드의 나머지 부분을 여기 아래에 그대로 붙여넣으면 바로 실행됨.
*/
/* ---------------------------------------------------------------------- */
function pruneDeadEnemies(){
  enemies = enemies.filter(e =>
    (e.hp > 0) ||
    (e.type === "boss" && e.dead && e.deathTimer > 0)
  );
  for(const p of packs){
    p.enemies = p.enemies.filter(e => e.hp > 0 || (e.type==="boss" && e.dead && e.deathTimer > 0));
  }
}

function getRandomVisibleAliveEnemy(){
  const visible = enemies.filter(e =>
    e.hp > 0 &&
    !(e.type === "boss" && e.dead) &&
    isEnemyOnScreen(e)
  );
  if(visible.length === 0) return null;
  return visible[(Math.random() * visible.length) | 0];
}

function getRandomAliveEnemy(){
  const alive = enemies.filter(e => e.hp > 0 && !(e.type === "boss" && e.dead));
  if(alive.length === 0) return null;
  return alive[(Math.random() * alive.length) | 0];
}

function getLevelPenalty(playerLv, monsterLv){
  const diff = monsterLv - playerLv;
  if(diff >= 0) return 1 + diff * 0.04;
  if(diff <= -6) return 0.1;
  return 1 + diff * 0.12;
}

/* ===== POE 맵핑: 티어 스케일/맵 생성 ===== */
function tierScale(t){
  const hpMul  = 1 + (t-1) * 0.22;
  const dmgMul = 1 + (t-1) * 0.16;
  const spdMul = 1 + Math.min(0.25, (t-1) * 0.02);
  const eliteChance = clamp(0.06 + (t-1) * 0.008, 0.06, 0.22);
  const eliteHpMul = 2.4;
  const eliteDmgMul = 1.9;
  return { hpMul, dmgMul, spdMul, eliteChance, eliteHpMul, eliteDmgMul };
}

function giveXP(enemy){
  let base = 0;
  if(enemy.type === "mage") base = 14;
  else if(enemy.type === "archer") base = 12;
  else if(enemy.type === "melee") base = 10;
  else if(enemy.type === "boss") base = 200 * mapTier;

  if(enemy.isElite) base *= 3;
  if(enemy.isLeader) base *= 4;

  const levelMul = getLevelPenalty(level, mapTier);
  const mapMul = 1 + (mapTier - 1) * 0.08;

  const finalXP = Math.floor(base * levelMul * mapMul);
  xp += finalXP;
  checkLevelUp();
}

function makeEnemyStatsByTier(type, t){
  const s = tierScale(t);

  let baseHp, baseDmg, baseSpd;
  if(type === "mage"){
    baseHp  = 42;
    baseDmg = 9;
    baseSpd = 0.48;
  }else if(type === "archer"){
    baseHp  = 30;
    baseDmg = 14;
    baseSpd = 0.55;
  }else{
    baseHp  = 55;
    baseDmg = 11;
    baseSpd = 0.85;
  }

  return {
    hp:  baseHp  * s.hpMul,
    dmg: baseDmg * s.dmgMul,
    spd: baseSpd * s.spdMul,
    eliteChance: s.eliteChance,
    eliteHpMul: s.eliteHpMul,
    eliteDmgMul: s.eliteDmgMul
  };
}

function makeBossStatsByTier(t){
  const baseHp  = 900;
  const baseDmg = 26;
  const baseSpd = 0.62;

  const bossHp  = baseHp  * (1 + (t-1)*0.28);
  const bossDmg = baseDmg * (1 + (t-1)*0.18);
  const bossSpd = baseSpd * (1 + Math.min(0.18, (t-1)*0.015));

  return { bossHp, bossDmg, bossSpd };
}

function dist2(ax, ay, bx, by){
  const dx = ax - bx;
  const dy = ay - by;
  return dx*dx + dy*dy;
}

function srand(seed){
  let s = seed >>> 0;
  return function(){
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function clearSpawnArea(cx, cy, radiusTiles=3){
  const tx = Math.floor(cx / tileSize);
  const ty = Math.floor(cy / tileSize);
  for(let y=ty-radiusTiles; y<=ty+radiusTiles; y++){
    for(let x=tx-radiusTiles; x<=tx+radiusTiles; x++){
      if(x<=0||y<=0||x>=mapSize-1||y>=mapSize-1) continue;
      map[y][x] = 0;
    }
  }
}

function carveBossRoomAndCorridor(){
  const w = 7 + Math.floor(Math.random()*5);
  const h = 7 + Math.floor(Math.random()*5);
  const margin = 2;

  const corner = (Math.random()*4)|0;
  let x0, y0;

  if(corner===0){ x0 = mapSize - margin - w; y0 = margin; }
  if(corner===1){ x0 = margin; y0 = margin; }
  if(corner===2){ x0 = margin; y0 = mapSize - margin - h; }
  if(corner===3){ x0 = mapSize - margin - w; y0 = mapSize - margin - h; }

  for(let y=y0; y<y0+h; y++){
    for(let x=x0; x<x0+w; x++){
      map[y][x] = 0;
    }
  }

  const cx = Math.floor(mapSize/2), cy = Math.floor(mapSize/2);
  const roomCx = x0 + (w>>1), roomCy = y0 + (h>>1);

  let doorX = roomCx;
  let doorY = roomCy;

  if(Math.abs(roomCx - cx) > Math.abs(roomCy - cy)){
    if(roomCx > cx){ doorX = x0;       doorY = roomCy; }
    else           { doorX = x0+w-1;   doorY = roomCy; }
  }else{
    if(roomCy > cy){ doorY = y0;       doorX = roomCx; }
    else           { doorY = y0+h-1;   doorX = roomCx; }
  }

  map[doorY][doorX] = 0;

  const startX = Math.floor(player.x / tileSize);
  const startY = Math.floor(player.y / tileSize);

  let x = startX, y = startY;
  const stepX = doorX > x ? 1 : -1;
  while(x !== doorX){
    map[y][x] = 0;
    map[y-1] && (map[y-1][x] = 0);
    map[y+1] && (map[y+1][x] = 0);
    x += stepX;
  }
  const stepY = doorY > y ? 1 : -1;
  while(y !== doorY){
    map[y][x] = 0;
    map[y][x-1] !== undefined && (map[y][x-1] = 0);
    map[y][x+1] !== undefined && (map[y][x+1] = 0);
    y += stepY;
  }
  map[doorY][doorX] = 0;

  bossRoom = { x:x0, y:y0, w, h, cx:roomCx, cy:roomCy, doorX, doorY };
}

function buildEmptyMap(){
  map = [];
  for(let y=0; y<mapSize; y++){
    let row = [];
    for(let x=0; x<mapSize; x++){
      if(x===0 || y===0 || x===mapSize-1 || y===mapSize-1) row.push(1);
      else row.push(0);
    }
    map.push(row);
  }
}

function placeRandomWalls(rng, wallCount){
  for(let i=0;i<wallCount;i++){
    const w = 2 + Math.floor(rng()*5);
    const h = 2 + Math.floor(rng()*5);
    const x0 = 1 + Math.floor(rng()*(mapSize-2-w));
    const y0 = 1 + Math.floor(rng()*(mapSize-2-h));

    const cx = Math.floor(mapSize/2);
    const cy = Math.floor(mapSize/2);
    if(Math.abs((x0 + (w>>1)) - cx) < 4 && Math.abs((y0 + (h>>1)) - cy) < 4){
      continue;
    }

    for(let y=y0; y<y0+h; y++){
      for(let x=x0; x<x0+w; x++){
        if(x<=0||y<=0||x>=mapSize-1||y>=mapSize-1) continue;
        map[y][x] = 1;
      }
    }
  }
}

function buildReachableMaskFromPlayer(){
  const startX = Math.floor(player.x / tileSize);
  const startY = Math.floor(player.y / tileSize);

  const vis = Array.from({length: mapSize}, ()=>Array(mapSize).fill(false));
  if(!map[startY] || map[startY][startX] !== 0) return vis;

  const q = [[startX, startY]];
  vis[startY][startX] = true;

  while(q.length){
    const [x,y] = q.pop();
    const nb = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
    for(const [nx,ny] of nb){
      if(nx<=0||ny<=0||nx>=mapSize-1||ny>=mapSize-1) continue;
      if(vis[ny][nx]) continue;
      if(map[ny][nx] !== 0) continue;
      vis[ny][nx] = true;
      q.push([nx,ny]);
    }
  }
  return vis;
}

function floodFillReachableFromPlayer(){
  const startX = Math.floor(player.x / tileSize);
  const startY = Math.floor(player.y / tileSize);
  if(!map[startY] || map[startY][startX] !== 0) return 0;

  const vis = Array.from({length: mapSize}, ()=>Array(mapSize).fill(false));
  const q = [[startX,startY]];
  vis[startY][startX] = true;
  let count = 0;

  while(q.length){
    const [x,y] = q.pop();
    count++;
    const nb = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
    for(const [nx,ny] of nb){
      if(nx<=0||ny<=0||nx>=mapSize-1||ny>=mapSize-1) continue;
      if(vis[ny][nx]) continue;
      if(map[ny][nx] !== 0) continue;
      vis[ny][nx] = true;
      q.push([nx,ny]);
    }
  }
  return count;
}

function generateRandomMapForTier(tier){
  const seed = (Date.now() ^ (tier*987654321)) >>> 0;
  const rng = srand(seed);

  for(let attempt=0; attempt<8; attempt++){
    buildEmptyMap();

    const wallCount = 22 + Math.floor(tier*2.2) + Math.floor(rng()*10);
    placeRandomWalls(rng, wallCount);

    clearSpawnArea(player.x, player.y, 3);

    const reachable = floodFillReachableFromPlayer();
    const totalFloor = (mapSize-2)*(mapSize-2);
    if(reachable / totalFloor >= 0.55){
      return seed;
    }
  }
  buildEmptyMap();
  clearSpawnArea(player.x, player.y, 4);
  return seed;
}

function startNewMap(nextTier){
  mapTier = nextTier;
  mapRun.tier = nextTier;
  mapRun.clearedPacks = 0;
  mapRun.bossSpawned = false;
  mapRun.bossDefeated = false;

  mapRun.packsToClear = 8 + Math.floor(nextTier * 1.5);

  portal.active = false;
  portal.hold = 0;

  enemies = [];
  packs = [];
  particles = [];
  bloodPools = [];
  bloodParticles = [];
  arrows = [];
  levelParticles = [];
  fireZones = [];

  spawnTimer = 0;
  spawnInterval = 999999;
  bossTimer = 0;

  player.x = mapSize * tileSize / 2;
  player.y = mapSize * tileSize / 2;

  mapRun.seed = generateRandomMapForTier(nextTier);
  carveBossRoomAndCorridor();
  reachableMask = buildReachableMaskFromPlayer();

  spawnMapPacks(nextTier);
  spawnRandomBoss();

  resize();
}

function spawnMapPacks(tier){
  const rng = srand(mapRun.seed ^ 0xA53C9E1B);

  const packCount = mapRun.packsToClear + 4 + Math.floor(tier*0.6);
  for(let i=0;i<packCount;i++){
    let placed = false;

    for(let tries=0; tries<120; tries++){
      const tx = 1 + Math.floor(rng()*(mapSize-2));
      const ty = 1 + Math.floor(rng()*(mapSize-2));
      if(map[ty][tx] !== 0) continue;
      if(reachableMask && !reachableMask[ty][tx]) continue;

      const px = tx*tileSize + tileSize/2;
      const py = ty*tileSize + tileSize/2;

      const dx = px - player.x, dy = py - player.y;
      if(dx*dx + dy*dy < 260*260) continue;

      let min = 25;
      let max = 32;
      if(tier >= 6){
        min = 28 + Math.floor((tier-5) * 0.4);
        max = 36 + Math.floor((tier-5) * 0.6);
      }
      if(tier >= 12){
        min = 30 + Math.floor((tier-10) * 0.5);
        max = 40 + Math.floor((tier-10) * 0.7);
      }
      max = Math.min(max, 45);

      const count = min + Math.floor(rng() * (max - min + 1));
      createPack(px, py, count);

      placed = true;
      break;
    }
    if(!placed){
      // skip
    }
  }

  for(const p of packs){
    p.cleared = false;
  }
  linkNearbyPacks();
}

function linkNearbyPacks(){
  const linkDist = 360;
  const link2 = linkDist * linkDist;

  const n = packs.length;
  const parent = Array.from({length:n}, (_,i)=>i);
  const find = (a)=>{ while(parent[a]!==a){ parent[a]=parent[parent[a]]; a=parent[a]; } return a; };
  const union = (a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[b]=a; };

  for(let i=0;i<n;i++){
    for(let j=i+1;j<n;j++){
      const dx = packs[i].x - packs[j].x;
      const dy = packs[i].y - packs[j].y;
      if(dx*dx + dy*dy <= link2) union(i,j);
    }
  }

  const rootToG = new Map();
  let gid = 0;

  for(let i=0;i<n;i++){
    const r = find(i);
    if(!rootToG.has(r)) rootToG.set(r, gid++);
    packs[i].groupId = rootToG.get(r);
    packs[i].groupCleared = false;
  }
}

function activatePackGroup(groupId){
  for(const p of packs){
    if(p.groupId === groupId){
      p.activated = true;
      if(p.enemies.length === 0 && !p.cleared){
        p.cleared = true;
      }
    }
  }
}

function spawnPortal(x, y){
  portal.active = true;
  portal.x = x;
  portal.y = y;
  portal.hold = 0;

  for(let i=0;i<90;i++){
    const a = Math.random()*Math.PI*2;
    const sp = 1 + Math.random()*5;
    particles.push({
      x: x + (Math.random()-0.5)*10,
      y: y + (Math.random()-0.5)*10,
      vx: Math.cos(a)*sp,
      vy: Math.sin(a)*sp,
      life: 30 + Math.floor(Math.random()*25)
    });
  }
}

function updatePortal(){
  if(!portal.active) return;

  const dx = player.x - portal.x;
  const dy = player.y - portal.y;
  const rr = (portal.r + player.radius + 8);
  if(dx*dx + dy*dy < rr*rr){
    portal.hold++;
    if(portal.hold >= portal.holdNeed){
      startNewMap(mapTier + 1);
      return;
    }
  }else{
    portal.hold = 0;
  }
}

function drawPortal(){
  if(!portal.active) return;

  const pulse = 0.6 + 0.4*Math.sin(frameCount*0.15);
  const r = portal.r + pulse*6;

  ctx.save();
  ctx.globalAlpha = 0.9;

  ctx.strokeStyle = "rgba(120,180,255,0.85)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(portal.x, portal.y, r, 0, Math.PI*2);
  ctx.stroke();

  ctx.fillStyle = "rgba(80,140,255,0.18)";
  ctx.beginPath();
  ctx.arc(portal.x, portal.y, r-6, 0, Math.PI*2);
  ctx.fill();

  if(portal.hold > 0){
    const t = clamp(portal.hold / portal.holdNeed, 0, 1);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(portal.x, portal.y, r+8, -Math.PI/2, -Math.PI/2 + Math.PI*2*t);
    ctx.stroke();
  }

  ctx.restore();
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function spawnHitBlood(x, y, amount=10){
  if(bloodParticles.length > 320) return;

  for(let i=0;i<amount;i++){
    bloodParticles.push({
      x: x + (Math.random()-0.5)*6,
      y: y + (Math.random()-0.5)*6,
      vx: (Math.random()-0.5) * 6,
      vy: (Math.random()-0.5) * 6,
      size: Math.random()*3 + 1.5,
      life: 22
    });
  }

  if(bloodPools.length < 140){
    bloodPools.push({
      x: x + (Math.random()-0.5)*8,
      y: y + (Math.random()-0.5)*8,
      size: 5 + Math.random()*4,
      life: 280
    });
  }
}

function startBossDeath(boss){
  if(boss.dead) return;
  if(!boss.xpGiven){
    boss.xpGiven = true;
    giveXP(boss);
  }
  boss.dead = true;
  boss.deathTimer = 60;
  boss.deathMax = 60;

  shake = Math.max(shake, 60);
  slowMotion = Math.max(slowMotion, 10);

  spawnHitBlood(boss.x, boss.y, 40);

  for(let i=0;i<140;i++){
    const a = Math.random()*Math.PI*2;
    const sp = 2 + Math.random()*8;
    particles.push({
      x: boss.x + (Math.random()-0.5)*10,
      y: boss.y + (Math.random()-0.5)*10,
      vx: Math.cos(a)*sp,
      vy: Math.sin(a)*sp - (Math.random()*2),
      life: 45 + Math.floor(Math.random()*25)
    });
  }

  if(bloodPools.length < 140){
    bloodPools.push({
      x: boss.x,
      y: boss.y,
      size: 26,
      life: 900
    });
  }

  spawnLoot(boss.x, boss.y, "boss");
  chaosOrbs++;
  bossDeathSound();
}

function canMoveTo(x,y){
  let left = Math.floor((x - player.radius) / tileSize);
  let right = Math.floor((x + player.radius) / tileSize);
  let top = Math.floor((y - player.radius) / tileSize);
  let bottom = Math.floor((y + player.radius) / tileSize);

  return (
    map[top] && map[top][left] === 0 &&
    map[top] && map[top][right] === 0 &&
    map[bottom] && map[bottom][left] === 0 &&
    map[bottom] && map[bottom][right] === 0
  );
}
function canEnemyMoveTo(enemy, x, y){
  let left = Math.floor((x - enemy.radius) / tileSize);
  let right = Math.floor((x + enemy.radius) / tileSize);
  let top = Math.floor((y - enemy.radius) / tileSize);
  let bottom = Math.floor((y + enemy.radius) / tileSize);

  return (
    map[top] && map[top][left] === 0 &&
    map[top] && map[top][right] === 0 &&
    map[bottom] && map[bottom][left] === 0 &&
    map[bottom] && map[bottom][right] === 0
  );
}
function isFloorTile(tx, ty){ return !!(map[ty] && map[ty][tx] === 0); }
function canSpawnEnemyAt(enemy, x, y){ return canEnemyMoveTo(enemy, x, y); }

function resolvePlayerEnemyOverlap(){
  const pad = 2;
  for(const e of enemies){
    if(e.type === "boss" && e.dead) continue;
    if(e.hp <= 0) continue;
    if(e.pack && !e.pack.activated) continue;

    let dx = e.x - player.x;
    let dy = e.y - player.y;
    let dist = Math.hypot(dx, dy);

    const minDist = player.radius + e.radius + pad;

    if(dist === 0){
      dx = (Math.random() - 0.5) * 0.01;
      dy = (Math.random() - 0.5) * 0.01;
      dist = Math.hypot(dx, dy);
    }

    if(dist < minDist){
      const nx = dx / dist;
      const ny = dy / dist;
      const push = (minDist - dist);

      const ex = e.x + nx * push;
      const ey = e.y + ny * push;

      if(canEnemyMoveTo(e, ex, ey)){
        e.x = ex; e.y = ey;
      }else{
        const px = player.x - nx * push;
        const py = player.y - ny * push;
        if(canMoveTo(px, player.y)) player.x = px;
        if(canMoveTo(player.x, py)) player.y = py;
      }
    }
  }
}

function damagePlayer(dmg, knockX, knockY, src){
  if(player.invul > 0 || gameOver) return;

  // ✅ STEP5: 플레이어가 받는 피해도 태그 기반으로 조절 가능
  let incoming = dmg;
  if(USE_TAG_CONTEXTS){
    const srcTags = src ? (src.tags ? src.tags : tagsFromEnemy(src)) : [];
    const ctxIn = { scope:'player', tags: mergeTags(['incoming'], getPlayerTags(), getMapTags(), srcTags) };
    incoming = applyPlayerTakenDamageMods(incoming, ctxIn);
  }

  const armor = (player.armor ?? 0);
  const reduced = incoming * (50 / (50 + Math.max(0, armor)));
  const finalDmg = Math.max(1, Math.floor(reduced));

  player.hp -= finalDmg;
  emitEvent("takeDamage", { dmg: finalDmg });
  player.invul = 25;
  shake = Math.max(shake, 10);

  let nx = player.x + knockX;
  let ny = player.y + knockY;

  if(canMoveTo(nx, player.y)) player.x = nx;
  if(canMoveTo(player.x, ny)) player.y = ny;

  if(player.hp <= 0) handleGameOver();
}

function enemyTryMeleeAttack(e){
  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const dist = Math.hypot(dx, dy);
  const reach = e.type === "boss" ? 70 : 42;

  if(dist > reach){
    e.attackFrame = 0;
    return;
  }

  if(e.attackFrame === 0){
    e.swingDir = dx < 0 ? -1 : 1;
  }

  const atkMul = (e.buffs?.atkSpdMul ?? 1);
  e.attackFrame += atkMul;

  if(e.attackFrame >= 12 && !e.hitDone){
    e.hitDone = true;
    const len = dist || 1;
    const nx = dx / len;
    const ny = dy / len;
    const kb = e.type === "boss" ? 30 : 18;
    damagePlayer(e.damage, nx*kb, ny*kb, e);
    hitSound();
  }

  if(e.attackFrame >= 25){
    e.attackFrame = 0;
    e.hitDone = false;
  }
}

function spawnArrow(fromX, fromY, toX, toY, damage){
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy) || 1;
  const speed = 7.5;

  arrows.push({
    x: fromX,
    y: fromY,
    dx: dx/dist * speed,
    dy: dy/dist * speed,
    damage,
    life: 240,
    tags: mergeTags(['projectile','arrow'], SKILL_TAGS.arrow || ['attack','projectile'])
  });
}

function spawnFireZone(x, y, damage){
  fireZones.push({ x, y, radius:55, life:180, tick:0, damage, tags: mergeTags(['aoe','fire'], SKILL_TAGS.firezone || ['spell','fire','aoe']) });
}

function spawnEnemyAt(ex, ey, pack){
  let tileX = Math.floor(ex / tileSize);
  let tileY = Math.floor(ey / tileSize);

  if(!isFloorTile(tileX, tileY)) return;
  if(!isFloorTile(tileX-1, tileY) || !isFloorTile(tileX+1, tileY) || !isFloorTile(tileX, tileY-1) || !isFloorTile(tileX, tileY+1)) return;
  if(enemies.length >= 320) return;

  let rand = Math.random();
  let type = rand < 0.2 ? "mage" : rand < 0.5 ? "archer" : "melee";

  const st = makeEnemyStatsByTier(type, mapTier);

  let enemy = {
    x: ex, y: ey,
    radius: 14,
    stun: 0,
    invul: 0,
    attackFrame: 0,
    swingDir: 1,
    type,
    hp: st.hp,
    speed: st.spd,
    damage: st.dmg,
    shootCooldown: 0,
    castCooldown: 120,
    pack
  };

  if(!canSpawnEnemyAt(enemy, ex, ey)) return;

  if(Math.random() < st.eliteChance * 0.85){
    enemy.isElite = true;
    enemy.eliteColor = Math.random() < 0.5 ? "yellow" : "blue";
    enemy.speed *= 1.5;
    enemy.damage *= st.eliteDmgMul;
    enemy.radius *= 1.2;
    enemy.hp *= st.eliteHpMul;
  }

    // ✅ STEP5: 적 태그 부여(엘리트 여부 포함)
  enemy.tags = mergeTags(tagsFromEnemy(enemy));

enemies.push(enemy);
  pack.enemies.push(enemy);
}

function spawnPackLeaderAt(ex, ey, pack){
  const st = makeEnemyStatsByTier("melee", mapTier);

  let leader = {
    x: ex, y: ey,
    radius: 18,
    stun: 0,
    invul: 0,
    attackFrame: 0,
    swingDir: 1,
    type: "melee",
    hp: st.hp * 3.2,
    speed: st.spd * 1.08,
    damage: st.dmg * 1.6,
    shootCooldown: 0,
    castCooldown: 120,
    pack,
    isLeader: true
  };

  if(!canSpawnEnemyAt(leader, ex, ey)) return;

  enemies.push(leader);
  pack.enemies.push(leader);
}

function spawnRandomBoss(){
  if(enemies.some(e => e.type === "boss")) return;

  const bx = bossRoom.cx * tileSize + tileSize/2;
  const by = bossRoom.cy * tileSize + tileSize/2;

  const tempBoss = { radius: 30 };
  if(!canEnemyMoveTo(tempBoss, bx, by)) return;

  const bst = makeBossStatsByTier(mapTier);

  enemies.push({
    x: bx, y: by,
    radius: 30,
    type: "boss",
    maxHp: bst.bossHp,
    hp: bst.bossHp,
    speed: bst.bossSpd,
    damage: bst.bossDmg,
    stun: 0,
    attackFrame: 0,
    swordPulled: false,
    phase2Used: false,
    dashCooldown: 120,
    cleaveCooldown: 160,
    invul: 0,
    phaseLock: 0
  });
}

function createPack(cx, cy, count){
  let pack = {
    x: cx, y: cy,
    enemies: [],
    activated: false,
    cleared: false,
    groupId: -1,
    groupCleared: false
  };

  spawnPackLeaderAt(cx, cy, pack);

  const normalCount = Math.max(0, count - 1);
  let tries = 0;

  while(pack.enemies.length < (normalCount + 1) && tries < count * 8){
    tries++;
    let angle = Math.random()*Math.PI*2;
    let radius = Math.random()*140;
    let ex = cx + Math.cos(angle)*radius;
    let ey = cy + Math.sin(angle)*radius;
    spawnEnemyAt(ex, ey, pack);
  }

  packs.push(pack);
}

/* ===== 궁극기 ===== */
function teleportTo(target){
  spawnHitBlood(player.x, player.y, 18);
  if(particles.length < 220){
    for(let i=0;i<10;i++){
      particles.push({ x: player.x, y: player.y, vx: (Math.random()-0.5)*10, vy: (Math.random()-0.5)*10, life: 22 });
    }
  }

  if(canMoveTo(target.x, target.y)){
    player.x = target.x;
    player.y = target.y;
  }

  spawnHitBlood(player.x, player.y, 22);
  if(particles.length < 220){
    for(let i=0;i<12;i++){
      particles.push({ x: player.x, y: player.y, vx: (Math.random()-0.5)*10, vy: (Math.random()-0.5)*10, life: 26 });
    }
  }

  shake = Math.max(shake, 10);
}

/* ===== 보스 스킬 ===== */
function bossEnterPhase2(boss){
  boss.swordPulled = true;
  boss.phase2Used = true;
  boss.speed *= 1.25;
  boss.damage *= 1.2;

  boss.invul = 120;
  boss.phaseLock = 36;

  shake = 30;
  bossUnsheatheSound();

  for(let i=0;i<80;i++){
    particles.push({ x: boss.x, y: boss.y, vx: (Math.random()-0.5)*10, vy: (Math.random()-0.5)*10, life: 50 });
  }
}

function bossDash(boss){
  const dx = player.x - boss.x;
  const dy = player.y - boss.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist;
  const ny = dy / dist;

  const dashDist = 220;
  const steps = 18;
  let hit = false;

  for(let i=0;i<steps;i++){
    let px = boss.x + nx * (dashDist/steps);
    let py = boss.y + ny * (dashDist/steps);

    if(canEnemyMoveTo(boss, px, py)){
      boss.x = px; boss.y = py;
    }else break;

    if(!hit){
      const d = Math.hypot(player.x - boss.x, player.y - boss.y);
      if(d < boss.radius + player.radius + 10){
        damagePlayer(boss.damage*1.2, nx*34, ny*34, boss);
        hit = true;
      }
    }
  }
  shake = Math.max(shake, 16);
}

function bossCleave(boss){
  const radius = 140;

  for(let i=0;i<70;i++){
    const a = Math.random()*Math.PI*2;
    const r = Math.random()*radius;
    particles.push({
      x: boss.x + Math.cos(a)*r,
      y: boss.y + Math.sin(a)*r,
      vx: Math.cos(a)*2 + (Math.random()-0.5)*2,
      vy: Math.sin(a)*2 + (Math.random()-0.5)*2,
      life: 35
    });
  }

  const dist = Math.hypot(player.x - boss.x, player.y - boss.y);
  if(dist < radius){
    const dx = player.x - boss.x;
    const dy = player.y - boss.y;
    const len = Math.hypot(dx, dy) || 1;
    damagePlayer(boss.damage*1.6, (dx/len)*42, (dy/len)*42, boss);
  }
  shake = Math.max(shake, 22);
}

function isEnemyOnScreen(e){
  const camX = player.x - canvas.width/2;
  const camY = player.y - canvas.height/2;

  const screenLeft   = camX - 50;
  const screenRight  = camX + canvas.width + 50;
  const screenTop    = camY - 50;
  const screenBottom = camY + canvas.height + 50;

  return (
    e.x > screenLeft &&
    e.x < screenRight &&
    e.y > screenTop &&
    e.y < screenBottom
  );
}

/* ===== 업데이트 ===== */

/* ===== GAME LOOP: UPDATE ===== */

function update(){
  frameCount++;

  if(lootOverlayOpen) return;
  if(gameOver) return;

  if(slowMotion > 0){
    slowMotion--;
    updateEnemySystem();
    resolvePlayerEnemyOverlap();
    updateEffectSystem();
    return;
  }

  updateBuffs(player);
  updatePlayerState();
  updateUltimateSystem();
  updateEnemySystem();
  resolvePlayerEnemyOverlap();
  updateCombatSystem();
  updateProjectileSystem();
  updateEffectSystem();
  updateEnvironmentSystem();

  updatePortal();
}

function updatePlayerState(){
  if(player.hp <= 0){ handleGameOver(); return; }
  updateMovement();
  updateInvulnerability();
  updateLevelGlow();

  const regen = (player.buffs?.hpRegen ?? 0) / 60;
  if(regen > 0) player.hp = Math.min(player.maxHp, player.hp + regen);
}
function handleGameOver(){
  gameOver = true;
  try{ if(window.Events && Events.emit) Events.emit("gameover", true); }catch(_){}
  try{ if(window.UI && typeof UI.onGameOver==="function") UI.onGameOver(); }catch(_){}
}
function updateLevelGlow(){
  if(player.levelGlow > 0) player.levelGlow--;
}

function updateUltimateSystem(){
  if(!player.ultiActive) return;

  player.ultiTimer++;
  if(player.ultiTimer % 10 === 0) performUltimateStrike();
  if(player.ultiCount >= 5) endUltimate();
}
function endUltimate(){
  player.ultiActive = false;
  player.ultiTimer = 0;
  player.ultiCount = 0;
  explosionActive = false;
}
function performUltimateStrike(){
  const target = getRandomVisibleAliveEnemy();
  if(!target) { endUltimate(); return; }

  teleportTo(target);
  dealUltimateDamage();

  pruneDeadEnemies();
  player.ultiCount++;
}

function dealUltimateDamage(){
  const radius = getUltiAoeRadius();
  const r2 = radius * radius;
  let killedAny = false;

  for(let i=0; i<enemies.length; i++){
    const e = enemies[i];
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    if(dx*dx + dy*dy > r2) continue;

    if(e.type === "boss" && e.dead) continue;

    const wasAlive = (e.hp > 0);
    if(!wasAlive) continue;

    const weaponBase = rollWeaponDamage();
const base =
  weaponBase * 2.8 *
  (player.buffs?.dmgMul ?? 1);

// ✅ POE식 버켓: outgoing(add/inc/more) → crit → enemy_taken
const ctxUlti = buildCombatCtx("ultimate", e);
const ultiRes = computeFinalDamage(base, ctxUlti, { canCrit:true });
const dealt = ultiRes.dealt;
const crit = ultiRes.crit;

    if(e.type === "boss"){
      if(e.invul <= 0){
        e.hp -= dealt;
        e.stun = 25;
        spawnHitBlood(e.x, e.y, crit.isCrit ? 26 : 14);
        shake = Math.max(shake, 20);
        if(e.hp <= 0){
          startBossDeath(e);
        }
      }
      continue;
    }

    e.hp -= dealt;
    e.stun = 30;

    spawnHitBlood(e.x, e.y, crit.isCrit ? 22 : 12);

    if(particles.length < 240){
      for(let k=0;k<10;k++){
        particles.push({ x: e.x, y: e.y, vx: (Math.random()-0.5)*9, vy: (Math.random()-0.5)*9, life: 34 });
      }
    }

    if(e.hp <= 0){
      emitEvent("kill", { enemy:e, x:e.x, y:e.y, type:e.type });
      spawnLoot(e.x, e.y, "ulti");
      giveXP(e);

      player.hp = Math.min(player.maxHp, player.hp + 1);
      slowMotion = 6;
      if(player.kiOrbs < player.maxOrbs) player.kiOrbs++;
      killedAny = true;
    }
  }

  if(killedAny) hitSound();
  shake = Math.max(shake, 30);
  pruneDeadEnemies();
}

function updateEnemySystem(){
  packs.forEach(pack=>{
    if(pack.activated) return;
    const dx = pack.x - player.x;
    const dy = pack.y - player.y;
    if(dx*dx + dy*dy < 520*520){
      activatePackGroup(pack.groupId);
      shake = Math.max(shake, 8);
      slowMotion = Math.max(slowMotion, 1);
    }
  });

  enemies.forEach(e=>{
    if(e.pack && !e.pack.activated) return;
    updateSingleEnemy(e);
  });
  for(const e of enemies){
    updateBuffs(e);
  }
  pruneDeadEnemies();
}

function updateLevelParticles(){
  for(let i = levelParticles.length - 1; i >= 0; i--){
    const p = levelParticles[i];
    p.ox += p.vx;
    p.oy -= p.vy;
    p.vy *= 0.97;
    p.life--;
    if(p.life <= 0) levelParticles.splice(i,1);
  }
  if(levelParticles.length > 200){
    levelParticles.splice(0, levelParticles.length - 200);
  }
}

function updateParticles(){
  for(let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.life--;
    if(p.life <= 0) particles.splice(i,1);
  }
  if(particles.length > 260){
    particles.splice(0, particles.length - 260);
  }
}

function updateMelee(e){
  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const dist = Math.hypot(dx, dy);

  if(dist > 0){
    let moveX = dx / dist * e.speed;
    let moveY = dy / dist * e.speed;

    let newX = e.x + moveX;
    let newY = e.y + moveY;

    if(canEnemyMoveTo(e, newX, e.y)) e.x = newX;
    if(canEnemyMoveTo(e, e.x, newY)) e.y = newY;
  }

  enemyTryMeleeAttack(e);
}

function updateArcher(e){
  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const dist = Math.hypot(dx, dy);

  const desired = 240;
  if(dist < desired - 40){
    const len = dist || 1;
    const nx = dx / len;
    const ny = dy / len;

    const newX = e.x - nx * e.speed * 1.2;
    const newY = e.y - ny * e.speed * 1.2;

    if(canEnemyMoveTo(e, newX, e.y)) e.x = newX;
    if(canEnemyMoveTo(e, e.x, newY)) e.y = newY;
  }else if(dist > desired + 80){
    updateMelee(e);
  }

  e.shootCooldown--;
  if(e.shootCooldown <= 0 && dist < 520){
    spawnArrow(e.x, e.y, player.x, player.y, e.damage);
    e.shootCooldown = 80 + Math.floor(Math.random()*40);
  }
}

function updateMage(e){
  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const dist = Math.hypot(dx, dy);

  if(dist < 180){
    const len = dist || 1;
    const nx = dx / len;
    const ny = dy / len;

    const newX = e.x - nx * e.speed * 1.4;
    const newY = e.y - ny * e.speed * 1.4;

    if(canEnemyMoveTo(e, newX, e.y)) e.x = newX;
    if(canEnemyMoveTo(e, e.x, newY)) e.y = newY;
  }else{
    updateMelee(e);
  }

  e.castCooldown--;
  if(e.castCooldown <= 0 && dist < 520){
    spawnFireZone(player.x, player.y, e.damage);
    e.castCooldown = 140 + Math.floor(Math.random()*50);
  }
}

function updateBoss(e){
  if(!e.phase2Used && e.hp <= e.maxHp * 0.5) bossEnterPhase2(e);
  updateMelee(e);

  if(e.swordPulled){
    e.dashCooldown--;
    e.cleaveCooldown--;

    const dist = Math.hypot(player.x - e.x, player.y - e.y);

    if(e.dashCooldown <= 0 && dist > 160 && dist < 520){
      bossDash(e);
      e.dashCooldown = 160 + Math.floor(Math.random()*70);
    }
    if(e.cleaveCooldown <= 0 && dist < 220){
      bossCleave(e);
      e.cleaveCooldown = 200 + Math.floor(Math.random()*80);
    }
  }
}

function updateSingleEnemy(e){
  if(e.isLeader){
    const radius = 50;
    const r2 = radius * radius;

    for(const other of enemies){
      if(other === e) continue;
      const dx = other.x - e.x;
      const dy = other.y - e.y;
      if(dx*dx + dy*dy <= r2){
        applyBuff(other, "damage",   1.25, 15, "leader");
        applyBuff(other, "atkSpeed", 1.2,  15, "leader");
      }
    }
  }

  if(e.type === "boss" && e.dead){
    e.deathTimer--;

    if(e.deathTimer % 10 === 0){
      shake = Math.max(shake, 10);
      spawnHitBlood(
        e.x + (Math.random()-0.5)*12,
        e.y + (Math.random()-0.5)*12,
        10
      );
    }

    if(e.deathTimer === 1 && !mapRun.bossDefeated){
      mapRun.bossDefeated = true;
      spawnPortal(e.x, e.y);
    }

    return;
  }

  if(e.invul > 0) e.invul--;

  if(e.phaseLock > 0){
    e.phaseLock--;
    return;
  }

  if(e.stun > 0){
    e.stun--;
    return;
  }

  switch(e.type){
    case "archer": updateArcher(e); break;
    case "mage": updateMage(e); break;
    case "boss": updateBoss(e); break;
    default: updateMelee(e);
  }
}

function updateProjectileSystem(){
  updateArrows();
  updateFireZones();
}

function updateFireZones(){
  for(let i = fireZones.length - 1; i >= 0; i--){
    const f = fireZones[i];
    f.life--;
    f.tick++;

    if(f.tick % 10 === 0){

      if(f.isBleed){
        let hitCount = 0;

        for(const e of enemies){
          if(e.hp <= 0) continue;
          if(e.type === "boss" && e.dead) continue;

          const dx = e.x - f.x;
          const dy = e.y - f.y;
          if(dx*dx + dy*dy > f.radius*f.radius) continue;

          const ctxFz = buildCombatCtx("firezone", e);
          const fzRes = computeFinalDamage(f.damage, ctxFz, { canCrit:false });
          const dealt = fzRes.dealt;

          if(e.type === "boss"){
            if(e.invul <= 0 && !e.dead){
              e.hp -= dealt;
              if(e.hp <= 0) startBossDeath(e);
            }
          }else{
            e.hp -= dealt;
            if(e.hp <= 0){
              emitEvent("kill", { enemy:e, x:e.x, y:e.y, type:e.type });
              spawnLoot(e.x, e.y, "bleed");
              giveXP(e);
            }
          }

          player.hp = Math.min(player.maxHp, player.hp + dealt * 0.12);
          spawnHitBlood(e.x, e.y, 3);

          hitCount++;
          if(hitCount >= 10) break;
        }

        pruneDeadEnemies();

      }else{
        const dx = player.x - f.x;
        const dy = player.y - f.y;
        if(dx*dx + dy*dy < f.radius*f.radius){
          damagePlayer(f.damage, 0, 0, f);
        }
      }
    }

    if(f.life <= 0){
      fireZones.splice(i,1);
    }
  }
}

function updateEffectSystem(){
  updateParticles();
  updateBlood();
  updateLevelParticles();

  for(let i=bloodPools.length-1;i>=0;i--){
    bloodPools[i].life--;
    if(bloodPools[i].life <= 0) bloodPools.splice(i,1);
  }
  if(bloodPools.length > 120) bloodPools.splice(0, bloodPools.length-120);

  updateLoots();
}

function updateCombatSystem(){
  if(attacking){
    attackFrame++;
    if(attackFrame === 3) checkHit();
    if(attackFrame > 8){
      attacking = false;
      attackFrame = 0;
    }
  }
}

function updateMovement(){
  const moveSpeed = player.speed * (player.buffs?.spdMul ?? 1);
  let dx = 0;
  let dy = 0;

  if(keys["ArrowLeft"] || keys["a"]) dx -= moveSpeed;
  if(keys["ArrowRight"] || keys["d"]) dx += moveSpeed;
  if(keys["ArrowUp"] || keys["w"]) dy -= moveSpeed;
  if(keys["ArrowDown"] || keys["s"]) dy += moveSpeed;

  dx += joyDX * moveSpeed;
  dy += joyDY * moveSpeed;

  if(Math.abs(dx) > Math.abs(dy)){
    if(dx > 0) player.dir = "right";
    else if(dx < 0) player.dir = "left";
  }else{
    if(dy > 0) player.dir = "down";
    else if(dy < 0) player.dir = "up";
  }

  let newX = player.x + dx;
  let newY = player.y + dy;

  if(canMoveTo(newX, player.y)) player.x = newX;
  if(canMoveTo(player.x, newY)) player.y = newY;
}

function updateInvulnerability(){
  if(player.invul > 0) player.invul--;
}

function updateEnvironmentSystem(){ updateShake(); }
function updateShake(){ if(shake > 0) shake--; }

function updateArrows(){
  for(let i = arrows.length - 1; i >= 0; i--){
    const a = arrows[i];
    a.x += a.dx;
    a.y += a.dy;
    a.life--;

    const tx = Math.floor(a.x / tileSize);
    const ty = Math.floor(a.y / tileSize);
    if(!map[ty] || map[ty][tx] === 1){
      arrows.splice(i,1);
      continue;
    }

    const px = player.x, py = player.y;
    const dxp = a.x - px;
    const dyp = a.y - py;
    const rr = (player.radius + 4);
    if(dxp*dxp + dyp*dyp < rr*rr){
      const dx = px - a.x;
      const dy = py - a.y;
      const len = Math.hypot(dx, dy) || 1;
      damagePlayer(a.damage, (dx/len)*14, (dy/len)*14, a);
      arrows.splice(i,1);
      continue;
    }

    if(a.life <= 0){
      arrows.splice(i,1);
      continue;
    }
  }
}

/* ===== 레벨업 ===== */
function levelUpSound(){
  let o = audioCtx.createOscillator();
  let g = audioCtx.createGain();

  o.type = "triangle";
  o.frequency.setValueAtTime(400, audioCtx.currentTime);
  o.frequency.exponentialRampToValueAtTime(900, audioCtx.currentTime + 0.3);

  g.gain.setValueAtTime(0.3, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);

  o.connect(g);
  g.connect(audioCtx.destination);

  o.start();
  o.stop(audioCtx.currentTime + 0.3);
}

function checkLevelUp(){
  if(xp >= xpToNext){
    xp -= xpToNext;
    level++;

    xpToNext = Math.floor(100 + level * level * 20);

    player.baseMaxHp += 12;
    updateBuffs(player);
    player.hp = player.maxHp;

    baseDamageBase *= 1.08;
    ultiDamageBase *= 1.1;
    recalcFromGear();

    player.levelGlow = 60;

    for(let i=0;i<60;i++){
      levelParticles.push({
        ox:(Math.random()-0.5)*40,
        oy:-40+(Math.random()-0.5)*10,
        vx:(Math.random()-0.5)*2,
        vy:Math.random()*3+2,
        life:60
      });
    }

    levelUpSound();
  }
}

/* ===== 공격 범위 ===== */
const BASE_MELEE_RANGE = 40;
const BASE_ULTI_AOE    = 40;

function getMeleeRange(){
  const b = player.buffs || defaultBuffStats();
  return BASE_MELEE_RANGE * (b.rangeMul ?? 1);
}
function getUltiAoeRadius(){
  const b = player.buffs || defaultBuffStats();
  return BASE_ULTI_AOE * (b.rangeMul ?? 1);
}

/* ===== 공격 ===== */
function checkHit(){
  const range = getMeleeRange();
  const hitLimit = 12;
  let hitDone = 0;

  for(let i=0;i<enemies.length;i++){
    const e = enemies[i];

    const dx = e.x - player.x;
    const dy = e.y - player.y;

    const r = range + e.radius;
    if(dx*dx + dy*dy > r*r) continue;

    if(player.dir === "up" && dy >= 0) continue;
    if(player.dir === "down" && dy <= 0) continue;
    if(player.dir === "right" && dx <= 0) continue;
    if(player.dir === "left" && dx >= 0) continue;

    hitDone++;
    if(hitDone > hitLimit) break;

    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;

    const weaponBase = rollWeaponDamage();
const base =
  weaponBase
  * (player.gear?.dmgMul ?? 1)
  * (player.buffs?.dmgMul ?? 1);

// ✅ POE식 버켓: outgoing(add/inc/more) → crit → enemy_taken
const ctxHit = buildCombatCtx("attack", e);
const hitRes = computeFinalDamage(base, ctxHit, { canCrit:true });
const dealt = hitRes.dealt;

    const bossInvul = (e.type === "boss" && e.invul > 0);

    if(e.invul <= 0){
      e.hp -= dealt;
    }
    emitEvent("hit", { enemy: e, dealt });

    const heal = dealt * 0.05;
    player.hp = Math.min(player.maxHp, player.hp + heal);

    if(Math.random() < 0.2 && player.kiOrbs < player.maxOrbs){
      player.kiOrbs++;
    }

    if(bossInvul){
      spawnHitBlood(e.x, e.y, 14);
    }else{
      e.stun = 15;
      let ex = e.x + nx*18;
      let ey = e.y + ny*18;
      if(canEnemyMoveTo(e, ex, e.y)) e.x = ex;
      if(canEnemyMoveTo(e, e.x, ey)) e.y = ey;
    }

    if(bossInvul) thudSound();
    else hitSound();

    shake = 12;

    if(particles.length < 220){
      particles.push({
        x: e.x, y: e.y,
        vx: nx*4 + (Math.random()-0.5)*4,
        vy: ny*4 + (Math.random()-0.5)*4,
        life: 30
      });
    }

    if(e.hp <= 0){
      if(e.type === "boss"){
        startBossDeath(e);
        continue;
      }
      emitEvent("kill", { enemy: e, x: e.x, y: e.y, type: e.type });
      spawnLoot(e.x, e.y, "normal");
      giveXP(e);
      killCount++;

      player.hp = Math.min(player.maxHp, player.hp + 1);

      if(bloodPools.length < 140){
        bloodPools.push({
          x: e.x, y: e.y,
          size: 10 + Math.random()*6,
          life: 600
        });
      }

      slowMotion = 6;

      if(player.kiOrbs < player.maxOrbs){
        player.kiOrbs++;
      }
    }
  }

  enemies = enemies.filter(e => (e.hp > 0) || (e.type === "boss" && e.dead && e.deathTimer > 0));
  packs.forEach(pack=>{
    pack.enemies = pack.enemies.filter(e=>e.hp>0);
  });
}

function updateBlood(){
  for(let i = bloodParticles.length - 1; i >= 0; i--){
    const p = bloodParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.25;
    p.life--;
    if(p.life <= 0) bloodParticles.splice(i,1);
  }
  if(bloodParticles.length > 260){
    bloodParticles.splice(0, bloodParticles.length - 260);
  }
}

function drawBlood(){
  if(bloodParticles.length === 0) return;

  ctx.save();
  ctx.fillStyle = "#8b0000";
  ctx.beginPath();

  for(let i=0;i<bloodParticles.length;i++){
    const p = bloodParticles[i];
    const a = p.life / 30;
    if(a > 0.66) ctx.globalAlpha = 0.9;
    else if(a > 0.33) ctx.globalAlpha = 0.6;
    else ctx.globalAlpha = 0.35;

    ctx.fillRect(p.x - p.size*0.5, p.y - p.size*0.5, p.size, p.size);
  }
  ctx.restore();
}

/* ===== 렌더 ===== */
function draw(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.filter = "none";

  ctx.fillStyle="#111";
  ctx.fillRect(0,0,canvas.width,canvas.height);

  let camX = player.x - canvas.width/2;
  let camY = player.y - canvas.height/2;

  let amp = shake ? (6 + shake * 0.45) : 0;
  let sx = shake ? (Math.random()-0.5) * amp : 0;
  let sy = shake ? (Math.random()-0.5) * amp : 0;

  ctx.save();
  ctx.translate(-camX+sx, -camY+sy);

  for(let y = 0; y < map.length; y++){
    for(let x = 0; x < map[y].length; x++){
      let tile = map[y][x];
      if(tile === 0) ctx.fillStyle = "#222";
      if(tile === 1) ctx.fillStyle = "#555";
      ctx.fillRect(x*tileSize, y*tileSize, tileSize, tileSize);
    }
  }

  ctx.fillStyle = "#550000";
  for(let i=0;i<bloodPools.length;i++){
    const b = bloodPools[i];
    const a = b.life / 600;
    if(a <= 0.05) continue;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.size, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  fireZones.forEach(f=>{
    ctx.save();
    for(let i=0;i<6;i++){
      let flameHeight = 10 + Math.sin(frameCount*0.2 + i)*6;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = "orange";
      ctx.beginPath();
      ctx.moveTo(f.x - 6 + i*2, f.y);
      ctx.lineTo(f.x - 3 + i*2, f.y - flameHeight);
      ctx.lineTo(f.x + i*2, f.y);
      ctx.fill();
    }
    ctx.restore();
  });

  ctx.fillStyle = "red";
  for(let i=0;i<particles.length;i++){
    const p = particles[i];
    ctx.fillRect(p.x, p.y, 3, 3);
  }

  drawPortal();
  drawLoots();
  drawBlood();
  enemies.forEach(e=>drawEnemy(e));

  levelParticles.forEach(p=>{
    ctx.fillStyle = "gold";
    ctx.fillRect(player.x + p.ox, player.y + p.oy, 4, 4);
  });

  arrows.forEach(a=>{
    ctx.fillStyle = "white";
    ctx.fillRect(a.x-2, a.y-2, 4, 4);
  });

  ctx.restore();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawPlayer(canvas.width/2, canvas.height/2);
  drawUI();
}

function drawPlayer(x,y){
  if(player.levelGlow > 0){
    ctx.shadowColor = "gold";
    ctx.shadowBlur = player.levelGlow * 0.5;
  }

  ctx.fillStyle="#880000";
  ctx.fillRect(x-10,y-12,20,22);

  ctx.fillStyle="#aa0000";
  ctx.fillRect(x-7,y-20,14,8);

  ctx.fillStyle="#ffffcc";
  ctx.fillRect(x-8,y-26,4,8);
  ctx.fillRect(x+4,y-26,4,8);

  ctx.fillStyle = "#fff";
  ctx.fillRect(x-3,y-14,2,2);
  ctx.fillRect(x+1,y-14,2,2);

  ctx.shadowBlur = 0;

  if(player.ultiActive){
    ctx.save();
    ctx.shadowColor = "#ff6600";
    ctx.shadowBlur = 25;
    ctx.fillStyle = "#ffaa00";
    ctx.fillRect(x-3,y-14,2,2);
    ctx.fillRect(x+1,y-14,2,2);
    ctx.restore();
  }

  drawSword(x,y);
}

function drawSword(x, y){
  ctx.save();
  ctx.translate(x, y);

  var offsetX = 0;
  var offsetY = 0;
  var angle = 0;
  var t = attackFrame / 8;

  if (player.dir === "right") { offsetX = 18; if (attacking) angle = 1.5 * t; }
  else if (player.dir === "left") { offsetX = -18; if (attacking) angle = -1.5 * t; }
  else if (player.dir === "up") { offsetY = -18; if (attacking) offsetY -= 25 * t; }
  else if (player.dir === "down") { offsetY = 6; angle = Math.PI; if (attacking) offsetY += 25 * t; }

  ctx.translate(offsetX, offsetY);
  ctx.rotate(angle);
  drawSwordShape(ctx);
  ctx.restore();
}

function drawSwordShape(c){
  c.fillStyle = "#552200";
  c.fillRect(-2, 6, 4, 8);

  c.fillStyle = "#bbbbbb";
  c.fillRect(-8, 6, 16, 3);

  c.fillStyle = "#dddddd";
  c.fillRect(-2, -20, 4, 26);

  c.beginPath();
  c.moveTo(-2, -20);
  c.lineTo(0, -32);
  c.lineTo(2, -20);
  c.fill();
}

function drawEnemy(e){
  if(e.type === "boss"){
    if(e.dead){
      const t = (e.deathTimer / e.deathMax);
      ctx.save();
      ctx.globalAlpha = Math.max(0, t);

      ctx.fillStyle = "rgba(255,60,60,0.25)";
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius + (1-t)*35, 0, Math.PI*2);
      ctx.fill();

      ctx.fillStyle = "#777777";
      ctx.fillRect(e.x-20, e.y-25, 40, 50);

      if(Math.floor(frameCount/3)%2===0){
        ctx.fillStyle = "rgba(255,0,0,0.8)";
        ctx.fillRect(e.x-6, e.y-15, 4,4);
        ctx.fillRect(e.x+2, e.y-15, 4,4);
      }

      ctx.restore();
      return;
    }

    if(e.invul > 0){
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = "red";
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius + 10, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = "#777777";
    ctx.fillRect(e.x-20, e.y-25, 40, 50);

    ctx.fillStyle = "#999999";
    ctx.fillRect(e.x-15, e.y-35, 30, 15);

    ctx.fillStyle = "red";
    ctx.fillRect(e.x-6, e.y-15, 4,4);
    ctx.fillRect(e.x+2, e.y-15, 4,4);

    ctx.save();
    ctx.translate(e.x+28, e.y);
    ctx.rotate(0.2);
    drawSwordShape(ctx);
    ctx.restore();
    return;
  }

  if(e.isLeader){
    ctx.fillStyle = "#ffd000";
    ctx.fillRect(e.x-6, e.y-24, 12, 3);
    ctx.fillRect(e.x-4, e.y-28, 3, 4);
    ctx.fillRect(e.x+1, e.y-28, 3, 4);
  }
  if(e.isElite){
    ctx.fillStyle = (e.eliteColor === "yellow") ? "#ffcc00" : "#00aaff";
  }else if(e.type === "archer"){
    ctx.fillStyle = "#cccccc";
  }else if(e.type === "mage"){
    ctx.fillStyle = "#550088";
  }else{
    ctx.fillStyle = "#006600";
  }

  if(e.activeBuffs && e.activeBuffs.some(b => b.key === "damage|leader|mul" || b.key === "atkSpeed|leader|mul")){
    const pulse = 0.45 + 0.25*Math.sin(frameCount*0.2);
    ctx.save();
    ctx.globalAlpha = 0.25 + pulse;
    ctx.fillStyle = "rgba(255,0,0,0.35)";
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius + 12 + pulse*6, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillRect(e.x-10,e.y-12,20,22);

  if(e.type === "archer") ctx.fillStyle = "#dddddd";
  else if(e.type === "mage") ctx.fillStyle = "#550088";
  else ctx.fillStyle = "#00aa00";
  ctx.fillRect(e.x-7,e.y-20,14,8);

  ctx.fillStyle="red";
  ctx.fillRect(e.x-4,e.y-14,3,3);
  ctx.fillRect(e.x+1,e.y-14,3,3);
}

/* ===== UI ===== */
function drawUI(){
  drawTextUI();
  drawXPBar();
  drawOrbUI();
  drawHpOrb();
  drawBossHpBar();
  drawMiniMap();

  // (디버그) 인벤 일부 표시
  ctx.font = "12px Arial";
  ctx.fillStyle = "#ccc";
  let startY = 140;
  for(let i=0;i<inventory.length && i<8;i++){
    ctx.fillText("• " + inventory[i].name, 20, startY + i*16);
  }
}

function drawXPBar(){
  const barW = canvas.width * 0.6;
  const barH = 10;
  const x = canvas.width/2 - barW/2;
  const y = canvas.height - 20;
  const percent = xp / xpToNext;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(x, y, barW, barH);
  ctx.fillStyle = "#33ccff";
  ctx.fillRect(x, y, barW * percent, barH);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.strokeRect(x, y, barW, barH);
  ctx.restore();
}

function drawMiniMap(){
  const w = 60;
  const h = 60;
  const margin = 12;
  const x0 = canvas.width - w - margin;
  const y0 = margin;

  const radarRange = 700;
  const scale = w / (radarRange * 2);

  const cx = x0 + w/2;
  const cy = y0 + h/2;

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "#000";
  ctx.fillRect(x0, y0, w, h);

  ctx.beginPath();
  ctx.rect(x0+1, y0+1, w-2, h-2);
  ctx.clip();

  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = "#888";
  ctx.lineWidth = 1;

  const minTX = Math.max(0, Math.floor((player.x - radarRange) / tileSize));
  const maxTX = Math.min(mapSize-1, Math.floor((player.x + radarRange) / tileSize));
  const minTY = Math.max(0, Math.floor((player.y - radarRange) / tileSize));
  const maxTY = Math.min(mapSize-1, Math.floor((player.y + radarRange) / tileSize));

  for(let ty=minTY; ty<=maxTY; ty++){
    for(let tx=minTX; tx<=maxTX; tx++){
      if(map[ty][tx] !== 1) continue;
      const wx = tx * tileSize;
      const wy = ty * tileSize;
      const dx = wx - player.x;
      const dy = wy - player.y;
      const mx = cx + dx * scale;
      const my = cy + dy * scale;
      const size = tileSize * scale;
      ctx.strokeRect(mx, my, size, size);
    }
  }

  const boss = enemies.find(e => e.type === "boss");
  if(boss){
    const dx = boss.x - player.x;
    const dy = boss.y - player.y;
    if(dx*dx + dy*dy <= radarRange*radarRange){
      const mx = cx + dx * scale;
      const my = cy + dy * scale;
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.fillRect(mx-3, my-3, 6, 6);
    }
  }

  ctx.globalAlpha = 0.95;
  for(const e of enemies){
    if(e.hp <= 0) continue;
    if(e.type === "boss") continue;
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    if(dx*dx + dy*dy > radarRange*radarRange) continue;
    const mx = cx + dx * scale;
    const my = cy + dy * scale;
    if(e.type === "mage") ctx.fillStyle = "#aa55ff";
    else if(e.type === "archer") ctx.fillStyle = "#dddddd";
    else ctx.fillStyle = "#00ff66";
    ctx.fillRect(mx-1.5, my-1.5, 3, 3);
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ff4444";
  ctx.fillRect(cx-2, cy-2, 4, 4);

  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 2;
  ctx.strokeRect(x0+1, y0+1, w-2, h-2);
  ctx.restore();
}

function drawTextUI(){
  ctx.save();
  ctx.textAlign = "left";
  ctx.font = "bold 18px Arial";
  ctx.fillStyle = "white";
  ctx.strokeStyle = "black";
  ctx.lineWidth = 4;

  const safeTop = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safeTop'))||0);
  const y1 = safeTop + 26;
  const y2 = safeTop + 58;

  ctx.strokeText("Level: " + level, 20, y1);
  ctx.fillText("Level: " + level, 20, y1);

  ctx.strokeText("TIER: " + mapTier, 20, y2);
  ctx.fillText("TIER: " + mapTier, 20, y2);

  if(portal.active){
    ctx.strokeText("PORTAL OPEN!", 20, safeTop + 90);
    ctx.fillText("PORTAL OPEN!", 20, safeTop + 90);
  }

  ctx.restore();
}

function drawOrbUI(){
  const btnRect = UI.el("attackBtn").getBoundingClientRect();
  const centerScreenX = btnRect.left + btnRect.width * 0.5;
  const centerScreenY = btnRect.top  + btnRect.height * 0.5;

  let cx = centerScreenX;
  let cy = centerScreenY - uiHeight;

  cx = Math.max(60, Math.min(canvas.width - 60, cx));
  cy = Math.max(60, Math.min(canvas.height - 60, cy));

  const orbR = 10;
  const ringR = 34;
  const startAngle = -Math.PI/2;

  const centerR = 24;
  const ready = (player.kiOrbs >= 1 && enemies.length > 0 && !player.ultiActive);

  orbUIState.cx = cx;
  orbUIState.cy = cy;
  orbUIState.centerR = centerR;
  orbUIState.ready = ready;

  ctx.save();

  for(let i=0;i<player.maxOrbs;i++){
    const a = startAngle + (i * (Math.PI * 2 / player.maxOrbs));
    const x = cx + Math.cos(a) * ringR;
    const y = cy + Math.sin(a) * ringR;

    ctx.beginPath();
    ctx.arc(x, y, orbR, 0, Math.PI*2);

    if(orbFlash > 0){
      ctx.fillStyle = "#00ff88";
      ctx.shadowColor = "#00ff88";
      ctx.shadowBlur = 35;
    }
    else if(i < player.kiOrbs){
      ctx.fillStyle = "#00ff55";
      ctx.shadowColor = "#00ff55";
      ctx.shadowBlur = 15;
    }
    else{
      ctx.fillStyle = "#002211";
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }

    ctx.fill();
  }

  ctx.shadowBlur = ready ? 25 : 10;
  ctx.shadowColor = ready ? "rgba(120,180,255,0.95)" : "rgba(120,180,255,0.4)";
  ctx.fillStyle = ready ? "rgba(40,120,255,0.95)" : "rgba(40,120,255,0.45)";
  ctx.beginPath();
  ctx.arc(cx, cy, centerR, 0, Math.PI*2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "rgba(170,210,255,0.75)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, centerR+1, 0, Math.PI*2);
  ctx.stroke();

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "white";
  ctx.font = "bold 18px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("U", cx, cy+1);

  ctx.restore();
}

function drawHpOrb(){
  const uiH = ui.getBoundingClientRect().height || 120;
  const padRect = UI.el("movePad").getBoundingClientRect();
  let x = padRect.left + padRect.width * 0.5;

  const btnRect = UI.el("attackBtn").getBoundingClientRect();
  let y = (btnRect.top + btnRect.height * 0.5) - uiH;

  x = Math.max(40, Math.min(canvas.width - 40, x));
  y = Math.max(40, Math.min(canvas.height - 40, y));

  ctx.save();

  let radius = 25;
  hpWaveOffset += 0.07;

  let hpPercent = player.hp / player.maxHp;
  let liquidHeight = radius * 2 * hpPercent;
  let topY = y + radius - liquidHeight;

  let metal = ctx.createRadialGradient(x, y, radius-10, x, y, radius+12);
  metal.addColorStop(0, "#2a0000");
  metal.addColorStop(0.5, "#550000");
  metal.addColorStop(1, "#110000");

  ctx.beginPath();
  ctx.arc(x, y, radius+10, 0, Math.PI*2);
  ctx.fillStyle = metal;
  ctx.fill();

  ctx.lineWidth = 4;
  ctx.strokeStyle = "#000";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, radius+6, 0, Math.PI*2);
  ctx.strokeStyle = "#aa0000";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI*2);
  ctx.clip();

  let innerShadow = ctx.createRadialGradient(x, y+15, 10, x, y, radius);
  innerShadow.addColorStop(0, "#330000");
  innerShadow.addColorStop(1, "#000000");
  ctx.fillStyle = innerShadow;
  ctx.fillRect(x-radius, y-radius, radius*2, radius*2);

  ctx.beginPath();
  ctx.moveTo(x-radius, y+radius);
  for(let i=0;i<=radius*2;i++){
    let wave = Math.sin(i*0.12 + hpWaveOffset) * 4;
    ctx.lineTo(x-radius+i, topY + wave);
  }
  ctx.lineTo(x+radius, y+radius);
  ctx.closePath();

  let blood = ctx.createLinearGradient(0, topY, 0, y+radius);
  blood.addColorStop(0, "#ff2a2a");
  blood.addColorStop(1, "#8b0000");
  ctx.fillStyle = blood;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x-15, y-20, 18, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fill();

  let glass = ctx.createRadialGradient(x-10, y-15, 5, x, y, radius);
  glass.addColorStop(0, "rgba(255,255,255,0.25)");
  glass.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glass;
  ctx.fillRect(x-radius, y-radius, radius*2, radius*2);

  if(hpPercent < 0.3){
    if(Math.floor(Date.now()/200)%2===0){
      ctx.beginPath();
      ctx.arc(x, y, radius+14, 0, Math.PI*2);
      ctx.fillStyle = "rgba(255,0,0,0.25)";
      ctx.fill();
    }
  }

  ctx.fillStyle = "white";
  ctx.font = "bold 16px Arial";
  ctx.textAlign = "center";
  ctx.fillText(Math.floor(player.hp), x, y+6);

  ctx.restore();
  ctx.restore();
}

function drawBossHpBar(){
  const boss = enemies.find(e => e.type === "boss");
  if(!boss) return;

  let camX = player.x - canvas.width/2;
  let camY = player.y - canvas.height/2;

  const screenX = boss.x - camX;
  const screenY = boss.y - camY;

  if(screenX < -100 || screenX > canvas.width + 100 || screenY < -100 || screenY > canvas.height + 100) return;

  const barW = 70;
  const barH = 7;
  const x = screenX - barW/2;
  const y = screenY - boss.radius - 18;

  let percent = boss.hp / boss.maxHp;
  percent = Math.max(0, Math.min(1, percent));

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x, y, barW, barH);
  ctx.fillStyle = "#ff4444";
  ctx.fillRect(x, y, barW * percent, barH);
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, barH - 1);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "10px Arial";
  ctx.textAlign = "center";
  ctx.fillText(Math.ceil(boss.hp), screenX, y - 2);
  ctx.restore();
}

function drawGameOver(){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle="rgba(0,0,0,0.6)";
  ctx.fillRect(0,0,canvas.width,canvas.height);

  ctx.fillStyle="white";
  ctx.font="bold 40px Arial";
  ctx.textAlign="center";
  ctx.fillText("GAME OVER", canvas.width/2, canvas.height/2);

  ctx.font="bold 18px Arial";
  ctx.fillText("Tap to Restart", canvas.width/2, canvas.height/2 + 40);
}

function tryUltimate(){
  if(player.ultiActive) return;
  if(player.kiOrbs >= 1 && enemies.length > 0){
    player.kiOrbs -= 1;
    player.ultiActive = true;
    player.ultiTimer = 0;
    player.ultiCount = 0;
    performUltimateStrike();
    endUltimate();
  }
}

function handleUltimateOrbPress(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  const tx = clientX - rect.left;
  const ty = clientY - rect.top;

  const dx = tx - orbUIState.cx;
  const dy = ty - orbUIState.cy;
  const r = orbUIState.centerR;

  if(dx*dx + dy*dy <= r*r){
    tryUltimate();
    return true;
  }
  return false;
}


/* ============================= */
/* ✅ 장비/가방/카오스 분리 UI 로직 */
/* ============================= */
// (이미 위에서 EQUIP_SLOTS/equipment/inventory/chaosOrbs 선언됨)

// UI refs
const equipOverlay = UI.el("equipOverlay");
const bagOverlay   = UI.el("bagOverlay");
const craftOverlay = UI.el("craftOverlay");

const equipSlotsEl = UI.el("equipSlots");
const specTextEl   = UI.el("specText");
const equipInfoEl  = UI.el("equipInfo");

const bagGridEl    = UI.el("bagGrid");
const bagInfoEl    = UI.el("bagInfo");

const orbCountsEl = UI.el("orbCounts");
const craftItemTextEl = UI.el("craftItemText");
const craftItemIconCv = UI.el("craftItemIcon");
const orbDescEl = UI.el("orbDesc");

const btnTransmute = UI.el("orbTransmute");
const btnAlter     = UI.el("orbAlter");
const btnAug       = UI.el("orbAug");
const btnRegal     = UI.el("orbRegal");
const btnAlchemy   = UI.el("orbAlchemy");
const btnChaos     = UI.el("chaosBtn");
const btnScour     = UI.el("orbScour");
const btnExalt     = UI.el("orbExalt");
const btnAnnul     = UI.el("orbAnnul");
const btnDivine    = UI.el("orbDivine");
const btnCorrupt = UI.el("orbCorrupt");

const ORB_DESC = {
  transmute: "진화(Transmute): 노말 → 매직 (옵션 1~2개)",
  alteration: "변화(Alteration): 매직 재굴림 (옵션 1~2개)",
  augmentation: "확장(Augmentation): 매직이 1개일 때만 1개 추가 (2개면 불가)",
  regal: "제왕(Regal): 매직 → 레어 + 1개 추가",
  alchemy: "연금(Alchemy): 노말 → 레어 (옵션 4~6개)",
  chaos: "카오스(Chaos): 레어 재굴림 (옵션 4~6개)",
  scour: "정제(Scour): 매직/레어 → 노말 (옵션 0개)",
  exalt: "엑잘(Exalt): 레어에 1개 추가 (빈 접두/접미 슬롯 있을 때만)",
  annul: "소멸(Annul): 랜덤 1개 제거 (희귀도 유지)",
  divine: "신성(Divine): 값만 재굴림 (옵션 종류/개수 유지)",
  corrupt: "+타락: 기존 임플릿 제거 후 (1) 임플릿 1개 추가 / (2) 변화 없음 / (3) 아이템 파괴"
};
// 오브 설명 바인딩
function bindOrbDesc(btn, key){
  if(!btn) return;
  btn.addEventListener("mouseenter", ()=>{ if(orbDescEl) orbDescEl.textContent = ORB_DESC[key]||""; });
  btn.addEventListener("click", ()=>{ if(orbDescEl) orbDescEl.textContent = ORB_DESC[key]||""; });
}
bindOrbDesc(btnTransmute,"transmute");
bindOrbDesc(btnAlter,"alteration");
bindOrbDesc(btnAug,"augmentation");
bindOrbDesc(btnRegal,"regal");
bindOrbDesc(btnAlchemy,"alchemy");
bindOrbDesc(btnChaos,"chaos");
bindOrbDesc(btnScour,"scour");
bindOrbDesc(btnExalt,"exalt");
bindOrbDesc(btnAnnul,"annul");
bindOrbDesc(btnDivine,"divine");
bindOrbDesc(btnCorrupt,"corrupt");
let panelOpen = null; // "equip" | "bag" | "craft" | null

// 선택: 가방/장비 공용
let selectedItem = null; // {from:"bag", idx} | {from:"equip", slot}

function stopEvt(e){
  if(!e) return;
  if(e.preventDefault) e.preventDefault();
  if(e.stopPropagation) e.stopPropagation();
}

function slotLabel(slot){
  if(slot==="weapon") return "무기";
  if(slot==="helm")   return "투구";
  if(slot==="chest")  return "갑옷";
  if(slot==="ring")   return "반지";
  return slot;
}
function rarityKey(it){
  if(!it) return "normal";
  const r = normalizeRarity(it.rarity);
  if(it.isUnique || r === "unique") return "unique";
  return r;
}

function rarityClass(it){
  return "r-" + rarityKey(it);
}
function escHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
/* ===== 표시용 퍼센트 유틸 ===== */
function fmtPct1(n){
  // 1자리까지 반올림, 끝 .0 제거
  const v = Math.round(n*10)/10;
  return String(v).replace(/\.0$/, "");
}
function fmtIncPctFromMul(m){
  const pct = (Number(m)||0) * 100 - 100; // mul(1.10) -> 10
  const abs = Math.abs(pct);
  const s = fmtPct1(abs);
  if(abs < 0.05) return "0% 증가";
  return (pct >= 0) ? `${s}% 증가` : `${s}% 감소`;
}
function fmtCritBonusFromMul(m){
  const pct = (Number(m)||0) * 100 - 100;
  const s = fmtPct1(pct);
  // 치피는 POE 느낌으로 +50% 표기
  return (pct >= 0) ? `+${s}%` : `${s}%`;
}


function rarityKey(it){
  if(!it) return "normal";
  const r = normalizeRarity(it.rarity);
  if(it.isUnique || r === "unique") return "unique";
  return r;
}
function rarityClass(it){
  return "r-" + rarityKey(it);
}
function fmtPct(x, digits=1){
  // x가 0.123이면 12.3%
  const p = x * 100;
  const v = Math.round(p * Math.pow(10, digits)) / Math.pow(10, digits);
  // 0.0 같은 값이면 소수 없애기
  return (Math.abs(v - Math.round(v)) < 1e-9) ? String(Math.round(v)) : String(v);
}

function fmtNum(x, digits=2){
  const v = Math.round(x * Math.pow(10, digits)) / Math.pow(10, digits);
  return (Math.abs(v - Math.round(v)) < 1e-9) ? String(Math.round(v)) : String(v);
}


function formatAffixReadable(mod){
  if(!mod) return "";

  // mod는 (1) roll object {kind, affix, tier, value} 또는 (2) affix object 자체일 수 있음
  const a = mod.affix || mod;
  const v = (typeof mod.value === "number") ? mod.value : a.value;

  const g = String(a.group || a.stat || a.id || "").toLowerCase();
  const name = a.name || a.id || "옵션";

  const num = (x)=> (typeof x==="number" && isFinite(x)) ? x : 0;
  const pct = (x)=>`${Math.round(num(x))}%`;
  const pct1 = (x)=>`${num(x).toFixed(1)}%`;

  // ===== 퍼센트/수치 표기 규칙 =====
  // - 피해/공속/범위/저항/치확/치피 등: %로 표기
  // - 최대체력/추가물리: 숫자
  // - 재생: /s

  // 피해(%) 
  if(g.includes("spell_damage")) return `주문 피해 +${pct(v)}`;
  if(g.includes("fire_damage")) return `화염 피해 +${pct(v)}`;
  if(g.includes("cold_damage")) return `냉기 피해 +${pct(v)}`;
  if(g.includes("light_damage")) return `번개 피해 +${pct(v)}`;
  if(g.includes("phys") && !g.includes("flat")) return `물리 피해 +${pct(v)}`;

  // flat phys
  if(g.includes("phys_flat")) return `추가 물리 피해 +${Math.round(num(v))}`;

  // 속도/범위
  if(g.includes("attackspeed")) return `공격 속도 +${pct(v)}`;
  if(g === "range" || g.includes("melee_range")) return `범위 +${pct(v)}`;

  // 치명
  if(g.includes("critchance")) return `치명타 확률 +${pct1(v)}`;
  if(g.includes("critmulti")) return `치명타 피해 +${pct(v)}`;

  // 생존
  if(g.includes("life_leech")) return `생명력 흡수 ${pct(v)}`;
  if(g.includes("life") || g.includes("maxhp")) return `최대 체력 +${Math.round(num(v))}`;
  if(g.includes("hpregen")) return `재생 +${num(v).toFixed(2)}/s`;

  // 방어/이속
  if(g.includes("armor_pct")) return `방어도 +${pct(v)}`;
  if(g.includes("movespeed")) return `이동 속도 +${pct(v)}`;

  // 저항
  if(g.includes("resist_all")) return `모든 저항 +${Math.round(num(v))}`;
  if(g.includes("resist_fire")) return `화염 저항 +${Math.round(num(v))}`;
  if(g.includes("resist_cold")) return `냉기 저항 +${Math.round(num(v))}`;
  if(g.includes("resist_light")) return `번개 저항 +${Math.round(num(v))}`;

  // fallback: name + value
  if(typeof v === "number"){
    // 값이 0~1 소수면 %로 표시해보기(구형 데이터 호환)
    if(v > 0 && v < 1) return `${name} +${pct(v*100)}`;
    return `${name} +${Math.round(num(v))}`;
  }
  return `${name}`;
}


function rarityLabel(it){
  const r = normalizeRarity(it?.isUnique ? "unique" : (it?.rarity || "normal"));
  if(r==="unique") return "유니크";
  if(r==="rare") return "레어";
  if(r==="magic") return "매직";
  return "노멀";
}

function prettyItemHTML(it){
  if(!it) return "";

  const rCls = rarityClass(it);
  let html = `<div class="itemInfoWrap">`;

  // 1) 아이템 이름(등급 색)
  html += `<div class="itemInfoName ${rCls}">${escHtml(it.name || "")}</div>`;

  // 유니크(전설)는 예외 처리: 설명만 깔끔히
  if(it.isUnique){
    const desc = it.uniqueRef?.desc || it.desc || "";
    if(desc){
      html += `<div class="itemInfoLine itemInfoDim">${escHtml(desc)}</div>`;
    }
    html += `</div>`;
    return html;
  }

  // 2) 베이스 + ilvl + 베이스 티어
  const baseName = it.baseName || it.baseId || it.id || "";
  if(baseName){
    const bt = (typeof it.baseTier === "number") ? ` (티어 ${it.baseTier})` : "";
    html += `<div class="itemInfoLine itemInfoDim">베이스: ${escHtml(baseName)}${escHtml(bt)}</div>`;
  }
  if(typeof it.ilvl === "number"){
    html += `<div class="itemInfoLine itemInfoDim">아이템 레벨: ${it.ilvl}</div>`;
  }

  // 등급 표기
  html += `<div class="itemInfoLine itemInfoDim">등급: ${rarityLabel(it)}</div>`;

  // 3) 암묵 옵션(Implicit) — 접두/접미와 완전 분리
  const imps = Array.isArray(it.implicits) ? it.implicits : [];
  if(imps.length){
    html += `<div class="itemInfoGap"></div>`;
    html += `<div class="itemInfoLine itemInfoDim">암묵 옵션</div>`;
    for(const imp of imps){
      if(!imp) continue;
      // text가 있는 암묵만 출력 (헬퍼용 Min/Max 조각 등은 숨김)
      if(!imp.text) continue;
      const line = imp.text;
      html += `<div class="itemInfoLine">- ${escHtml(line)}</div>`;
    }
  }

  // 4) 베이스 옵션
  html += `<div class="itemInfoGap"></div>`;
  html += `<div class="itemInfoLine itemInfoDim">베이스 옵션</div>`;

  if(it.slot === "weapon" && typeof it.baseDamage === "number"){
    html += `<div class="itemInfoLine">- 기본 무기 피해 +${Math.floor(it.baseDamage)}</div>`;
  }

  if(it.baseData){
    const d = it.baseData;
    if(d.maxHpAdd) html += `<div class="itemInfoLine">- 최대 체력 +${Math.floor(d.maxHpAdd)}</div>`;
    if(d.armorAdd) html += `<div class="itemInfoLine">- 방어력 +${Math.floor(d.armorAdd)}</div>`;
    if(d.hpRegen)  html += `<div class="itemInfoLine">- 재생 +${d.hpRegen.toFixed(2)}/s</div>`;
  }

  // 4) 접두 / 접미 옵션만 표시
  const aff = Array.isArray(it.affixes) ? it.affixes : [];
  const prefixes = aff.filter(a => a && a.affix && a.kind === "prefix");
  const suffixes = aff.filter(a => a && a.affix && a.kind === "suffix");

  if(prefixes.length){
    html += `<div class="itemInfoGap"></div>`;
    html += `<div class="itemInfoLine itemInfoDim">접두</div>`;
    for(const a of prefixes){
      const tier = a.tier ? ` <span class="itemInfoTier">T${a.tier}</span>` : "";
      const line = formatAffixReadable(a);
      html += `<div class="itemInfoLine">- ${escHtml(line)}${tier}</div>`;
    }
  }

  if(suffixes.length){
    html += `<div class="itemInfoGap"></div>`;
    html += `<div class="itemInfoLine itemInfoDim">접미</div>`;
    for(const a of suffixes){
      const tier = a.tier ? ` <span class="itemInfoTier">T${a.tier}</span>` : "";
      const line = formatAffixReadable(a);
      html += `<div class="itemInfoLine">- ${escHtml(line)}${tier}</div>`;
    }
  }

  html += `</div>`;
  return html;
}

function rebuildGearFromEquipment(){
  player.gear = {
    armorAdd: 0, maxHpAdd: 0, hpRegen: 0,
    critChanceAdd: 0, critChanceMul: 1, critMultiAdd: 0,
  };

  for(const slot of EQUIP_SLOTS){
    const it = equipment[slot];
    if(!it) continue;
    if(it.isUnique) continue;
    const d = it.totalData || it.data;
    if(!d) continue;
    for(const k in d){
      const v = d[k];
      if(typeof v !== "number") continue;
      if(k.endsWith("Mul")) player.gear[k] *= v;
      else player.gear[k] += v;
    }
  }
  recalcFromGear();
  player.hp = Math.min(player.hp, player.maxHp);
}

/* ===== 아이템 아이콘: 이모지 대신 캔버스에 간단 도형 ===== */
function drawItemIcon(c, it){
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.clearRect(0,0,W,H);

  // 바탕(어두운 칸에서도 아이콘이 "보이게" 하이라이트)
  g.save();
  g.globalAlpha = 1;
  g.fillStyle = "rgba(0,0,0,0.15)";
  g.fillRect(0,0,W,H);

  // 테두리(희귀도) — PoE식: normal(흰) / magic(파) / rare(노) / unique(주황)
  const rr = normalizeRarity(it?.isUnique ? "unique" : (it?.rarity || "normal"));
  g.lineWidth = 3;

  if(rr==="unique") g.strokeStyle = "#ffb86b";
  else if(rr==="rare") g.strokeStyle = "#ffd166";
  else if(rr==="magic") g.strokeStyle = "#2f7bff";
  else g.strokeStyle = "#ffffff";

  // ✅ 동그라미 링 → 사각형 링(요청 반영)
  const pad = 4;
  g.strokeRect(pad, pad, W - pad*2, H - pad*2);

  // 슬롯이 없으면 빈칸
  if(!it){ g.restore(); return; }

  // 공통: 아이콘 중앙 정렬
  g.translate(W/2, H/2);
  g.globalAlpha = 0.98;

  // ===== 무기: 베이스 타입별 아이콘 =====
  if(it.slot==="weapon"){
    const baseId = it.baseId || it.id;
    const tmpl = getItemTemplateById(baseId);
    const wt = tmpl?.weaponType || tmpl?.type || (() => {
      const tags = tmpl?.tags || [];
      if(tags.includes("2h_axe") || tags.includes("axe")) return "2h_axe";
      if(tags.includes("2h_mace") || tags.includes("mace")) return "2h_mace";
      if(tags.includes("warstaff")) return "warstaff";
      if(tags.includes("staff")) return "staff";
      return "2h_sword";
    })();

    // 공통 스케일
    g.save();
    g.scale(1.0, 1.0);
    g.lineWidth = 4;
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.fillStyle = "rgba(255,255,255,0.75)";

    // 2H Sword: 기존 느낌(길쭉한 검)
    if(wt==="2h_sword"){
      g.beginPath();
      g.moveTo(-2, -16); g.lineTo(2, -16); g.lineTo(3, 10); g.lineTo(-3, 10);
      g.closePath(); g.fill();
      g.fillRect(-10, 6, 20, 3);   // 가드
      g.fillRect(-2, 10, 4, 8);    // 손잡이
    }
    // 2H Axe: 큰 도끼날
    else if(wt==="2h_axe"){
      g.fillRect(-2, -16, 4, 30);  // 자루
      g.beginPath();               // 도끼날
      g.moveTo(-2, -6);
      g.lineTo(-14, -12);
      g.lineTo(-14, 0);
      g.lineTo(-2, 2);
      g.closePath(); g.fill();
      g.beginPath();
      g.moveTo(2, -6);
      g.lineTo(8, -10);
      g.lineTo(8, 0);
      g.lineTo(2, 2);
      g.closePath(); g.fill();
      g.fillRect(-6, 8, 12, 3);    // 가드 느낌
    }
    // 2H Mace: 큰 철퇴머리
    else if(wt==="2h_mace"){
      g.fillRect(-2, -16, 4, 30);  // 자루
      g.fillRect(-8, -18, 16, 10); // 머리
      // 스파이크
      g.fillRect(-10, -16, 4, 2);
      g.fillRect(6, -16, 4, 2);
      g.fillRect(-2, -22, 4, 4);
      g.fillRect(-2, -8, 4, 3);
    }
    // Staff: 마법 지팡이(끝 구슬)
    else if(wt==="staff"){
      g.fillRect(-2, -16, 4, 30);
      g.beginPath();
      g.arc(0, -18, 6, 0, Math.PI*2);
      g.fill();
      g.fillRect(-4, 8, 8, 3);
    }
    // Warstaff: 전쟁지팡이(양끝 금속)
    else if(wt==="warstaff"){
      g.fillRect(-2, -16, 4, 30);
      g.fillRect(-8, -20, 16, 5);
      g.fillRect(-8, 12, 16, 5);
      g.fillRect(-5, -24, 10, 4);
      g.fillRect(-5, 17, 10, 4);
    }
    else{
      // fallback
      g.fillRect(-2, -16, 4, 30);
      g.fillRect(-10, 6, 20, 3);
    }

    g.restore();
  }


  // ===== 투구: "검투사 투구" =====
  else if(it.slot==="helm"){
    g.save();
    // 둥근 돔
    g.fillStyle = "#c7c7c7";
    g.beginPath();
    g.arc(0, -2, 13, Math.PI, 0);
    g.closePath();
    g.fill();

    // 볼가드/턱부분
    g.fillStyle = "#9b9b9b";
    g.beginPath();
    g.moveTo(-13, -2);
    g.lineTo(-13, 8);
    g.quadraticCurveTo(-6, 14, 0, 14);
    g.quadraticCurveTo(6, 14, 13, 8);
    g.lineTo(13, -2);
    g.closePath();
    g.fill();

    // 눈구멍(슬릿)
    g.fillStyle = "#1a1a1a";
    g.fillRect(-9, 1, 7, 3);
    g.fillRect(2, 1, 7, 3);

    // 중앙 능선(검투사 느낌)
    g.fillStyle = "#eaeaea";
    g.fillRect(-1, -14, 2, 26);

    // 하이라이트
    g.globalAlpha = 0.25;
    g.fillStyle="#fff";
    g.beginPath();
    g.arc(-5, -6, 10, Math.PI*1.05, Math.PI*1.55);
    g.strokeStyle="rgba(255,255,255,0.4)";
    g.lineWidth=2;
    g.stroke();

    g.restore();
  }

  // ===== 갑옷: "중세 기사 풀플레이트" =====
  else if(it.slot==="chest"){
    g.save();
    // 흉갑 본체
    g.fillStyle="#bdbdbd";
    g.beginPath();
    g.moveTo(-12, -12);
    g.lineTo(-8, 14);
    g.quadraticCurveTo(0, 18, 8, 14);
    g.lineTo(12, -12);
    g.closePath();
    g.fill();

    // 어깨 플레이트
    g.fillStyle="#9e9e9e";
    g.beginPath();
    g.moveTo(-14, -10);
    g.lineTo(-8, -14);
    g.lineTo(-4, -2);
    g.lineTo(-12, 0);
    g.closePath();
    g.fill();

    g.beginPath();
    g.moveTo(14, -10);
    g.lineTo(8, -14);
    g.lineTo(4, -2);
    g.lineTo(12, 0);
    g.closePath();
    g.fill();

    // 복부 판금 라인
    g.strokeStyle="rgba(0,0,0,0.35)";
    g.lineWidth=2;
    g.beginPath();
    g.moveTo(-8, 0); g.lineTo(8, 0);
    g.moveTo(-7, 5); g.lineTo(7, 5);
    g.moveTo(-6, 10); g.lineTo(6, 10);
    g.stroke();

    // 중앙 하이라이트
    g.globalAlpha = 0.28;
    g.fillStyle="#fff";
    g.fillRect(-2, -10, 2, 22);

    g.restore();
  }

  // ===== 반지: "파란 보석 박힌 반지" =====
  else if(it.slot==="ring"){
    g.save();
    // 링 바디
    g.strokeStyle="#e5e5e5";
    g.lineWidth=4;
    g.beginPath();
    g.arc(0, 2, 10, 0, Math.PI*2);
    g.stroke();

    // 보석(파란색)
    g.fillStyle="#3aa0ff";
    g.beginPath();
    g.arc(0, -8, 4, 0, Math.PI*2);
    g.fill();

    // 보석 하이라이트
    g.globalAlpha = 0.35;
    g.fillStyle="#ffffff";
    g.beginPath();
    g.arc(-1, -9, 2, 0, Math.PI*2);
    g.fill();

    // 보석 받침(세팅)
    g.globalAlpha = 1;
    g.fillStyle="#cfcfcf";
    g.fillRect(-3, -6, 6, 2);

    g.restore();
  }

  // 그 외
  else{
    g.save();
    g.fillStyle="#999";
    g.fillRect(-10,-10,20,20);
    g.restore();
  }

  g.restore();
}

function getSelectedItem(){
  if(!selectedItem) return null;
  if(selectedItem.from==="bag") return inventory[selectedItem.idx] || null;
  if(selectedItem.from==="equip") return equipment[selectedItem.slot] || null;
  return null;
}

/* ===== 렌더: 장비/스펙 ===== */

/* ===== UI: EQUIP PANEL ===== */

function renderEquipPanel(){
  equipSlotsEl.innerHTML = "";

  // ✅ 스펙창 장착 슬롯 순서 고정: 무기, 투구, 갑옷, 반지
  const SLOT_ORDER = ["weapon","helm","chest","ring"];

  for(const slot of SLOT_ORDER){
    const it = equipment[slot];

    const d = document.createElement("div");
    d.className = "eSlotSmall";
    if(it) d.classList.add(rarityClass(it));
    if(selectedItem && selectedItem.from==="equip" && selectedItem.slot===slot) d.classList.add("selected");

    const c = document.createElement("canvas");
    c.width = 44; c.height = 44;
    d.appendChild(c);
    drawItemIcon(c, it);

    d.addEventListener("click", ()=>{
      // 1) 가방에서 선택한 아이템이 있으면 -> 해당 슬롯에 장착
      if(selectedItem && selectedItem.from==="bag"){
        equipFromBagToSlot(selectedItem.idx, slot);
        selectedItem = {from:"equip", slot};
        renderAllPanels();
        return;
      }

      // 2) 스펙창에서 슬롯 선택/해제(토글)
      if(!selectedItem || selectedItem.from!=="equip" || selectedItem.slot!==slot){
        selectedItem = {from:"equip", slot};
      }else{
        // ✅ 다시 누르면: 선택만 해제 (더블탭/연타로 아이템 빠지는 기능 제거)
        selectedItem = null;
      }
      renderAllPanels();
    });

    equipSlotsEl.appendChild(d);
  }

  const g = player.gear || {};
  specTextEl.textContent =
`생명력: ${player.hp.toFixed(0)} / ${player.maxHp.toFixed(0)}
방어도: ${(player.armor ?? 0).toFixed(0)}
초당 생명력 재생: ${(g.hpRegen ?? 0).toFixed(2)}

공격 피해: ${fmtIncPctFromMul(g.dmgMul ?? 1)}
공격 속도: ${fmtIncPctFromMul(g.atkSpdMul ?? 1)}
사거리: ${fmtIncPctFromMul(g.rangeMul ?? 1)}

치명타 확률: ${(getCritChance()*100).toFixed(1)}%
치명타 피해 배율: +${((getCritMulti()-1)*100).toFixed(0)}%

이동 속도: ${fmtIncPctFromMul(g.spdMul ?? 1)}`;
// ✅ 스펙창의 아이템 상세정보는 '스펙창에서 선택한 슬롯'만 보여준다
  const itSel = (selectedItem && selectedItem.from==="equip") ? getSelectedItem() : null;
  equipInfoEl.innerHTML = itSel ? prettyItemHTML(itSel) : "";
}

/* ===== 렌더: 가방 ===== */

/* ===== UI: BAG PANEL ===== */

function renderBagPanel(){
  bagGridEl.innerHTML = "";
  const minSlots = 24;
  const fillTo = Math.max(minSlots, Math.ceil((inventory.length)/6)*6);

  for(let i=0;i<fillTo;i++){
    const it = inventory[i] || null;

    const cell = document.createElement("div");
    cell.className = "bItem";
    if(it) cell.classList.add(rarityClass(it));
    if(it && it.isUnique) cell.classList.add("unique");
    if(selectedItem && selectedItem.from==="bag" && selectedItem.idx===i) cell.classList.add("selected");
    if(!it) cell.style.opacity = "0.35";

    const c = document.createElement("canvas");
    c.width = 40; c.height = 40;
    c.className = "iconCanvas";
    cell.appendChild(c);
    drawItemIcon(c, it);
    c.style.display = "block";
c.style.background = "rgba(255,255,255,0.06)";

  cell.addEventListener("pointerup", (e)=>{
  e.preventDefault();

  if(!it){
    selectedItem = null;
  }else{
    selectedItem = {from:"bag", idx:i};
  }

  renderAllPanels();
}, {passive:false});

    bagGridEl.appendChild(cell);
  }

  const it = getSelectedItem();
  if(it && selectedItem?.from==="bag") bagInfoEl.innerHTML = prettyItemHTML(it);
else if(!bagInfoEl.innerHTML) bagInfoEl.innerHTML = "";
bagInfoEl.style.minHeight = "140px";
bagInfoEl.style.overflowY = "auto";
bagInfoEl.style.boxSizing = "border-box";
}

/* ===== 렌더: 카오스 ===== */

/* ===== UI: CHAOS PANEL ===== */

function renderCraftPanel(){
  // 기본 안내
  if(orbDescEl) orbDescEl.textContent = "오브를 선택하면 설명이 표시됩니다.";
  const it = getSelectedItem();

  // 오브 카운트 표시
  if(orbCountsEl){
    orbCountsEl.textContent =
      `변환 ${transmuteOrbs}  변화 ${alterationOrbs}
` +
      `증강 ${augmentationOrbs}  제왕 ${regalOrbs}
` +
      `연금 ${alchemyOrbs}  카오스 ${chaosOrbs}
` +
      `세공 ${scouringOrbs}  승격 ${exaltedOrbs}
` +
      `소멸 ${annulOrbs}  신성 ${divineOrbs}`;
  }

  // 기본 비활성
  const btns = [btnTransmute,btnAlter,btnAug,btnRegal,btnAlchemy,btnChaos,btnScour,btnExalt,btnAnnul,btnDivine,btnCorrupt];
  for(const b of btns){ if(b) b.disabled = true; }

  if(!it){
    craftItemTextEl.innerHTML = "<div style='color:#bbb'>아이템을 먼저 선택하세요.</div>";
    return;
  }
  if(it.isUnique){
    craftItemTextEl.innerHTML = "<div style='color:#bbb'>전설(유니크)은 제작 불가.</div>" + prettyItemHTML(it);
    return;
  }

  const r = it.rarity || "normal";
  const affCnt = Array.isArray(it.affixes) ? it.affixes.length : 0;

  // 조건별 버튼 활성
  if(btnTransmute) btnTransmute.disabled = !(transmuteOrbs>0 && r==="normal");
  if(btnAlter)     btnAlter.disabled     = !(alterationOrbs>0 && r==="magic");
  if(btnAug)       btnAug.disabled       = !(augmentationOrbs>0 && r==="magic" && affCnt < 2);
  if(btnRegal)     btnRegal.disabled     = !(regalOrbs>0 && r==="magic" && affCnt>=1);
  if(btnAlchemy)   btnAlchemy.disabled   = !(alchemyOrbs>0 && r==="normal");
  if(btnChaos)     btnChaos.disabled     = !(chaosOrbs>0 && (r==="rare" || r==="rare"));
  if(btnScour)     btnScour.disabled     = !(scouringOrbs>0 && r!=="normal");
  if(btnExalt)     btnExalt.disabled     = !(exaltedOrbs>0 && (r==="rare"||r==="rare") && affCnt < maxAffixesForRarity(r));
  if(btnAnnul)     btnAnnul.disabled     = !(annulOrbs>0 && affCnt > 0);
  if(btnDivine)    btnDivine.disabled    = !(divineOrbs>0 && affCnt > 0);

  craftItemTextEl.innerHTML = prettyItemHTML(it);

  try{ drawItemIcon(craftItemIconCv, it); }catch(e){}
}


/* ===== UI: RENDER ALL PANELS ===== */


function renderAllPanels(){
  safeCall(renderEquipPanel, "renderEquipPanel");
  safeCall(renderBagPanel,  "renderBagPanel");
  safeCall(renderCraftPanel, "renderCraftPanel");

  _callHook('afterRenderPanels');
}

/* ===== 장착/해제 ===== */
function equipFromBagToSlot(invIndex, slot){
  const it = inventory[invIndex];
  if(!it) return;
  if(it.isUnique) return;
  if(it.slot !== slot) return;

  if(equipment[slot]) inventory.push(equipment[slot]);
  inventory.splice(invIndex, 1);
  equipment[slot] = it;

  selectedItem = {from:"equip", slot};
  rebuildGearFromEquipment();
  renderAllPanels();

  _callHook('afterEquip', slot, equipment[slot]);
}

function unequipSlotToBag(slot){
  const it = equipment[slot];
  if(!it) return;
  equipment[slot] = null;
  inventory.push(it);
  selectedItem = null;
  rebuildGearFromEquipment();
  renderAllPanels();

  _callHook('afterUnequip', slot);
}

/* ===== 패널 열고 닫기 ===== */
function openPanel(which){
  document.body.classList.add("panel-open");
  overlayPush();
  pauseGame({ dim: 0.60, blur: 2 });
  panelOpen = which;

  equipOverlay.style.display = (which==="equip") ? "flex" : "none";
  bagOverlay.style.display   = (which==="bag")   ? "flex" : "none";
  craftOverlay.style.display = (which==="craft") ? "flex" : "none";

  renderAllPanels();
}
function closePanels(){
  document.body.classList.remove("panel-open");
  panelOpen = null;
  equipOverlay.style.display = "none";
  bagOverlay.style.display   = "none";
  craftOverlay.style.display = "none";
  overlayPop();
  resumeGame();
}

// HUD buttons
UI.el("btnEquip").addEventListener("click", (e)=>{ stopEvt(e); openPanel("equip"); });
UI.el("btnBag").addEventListener("click", (e)=>{ stopEvt(e); openPanel("bag"); });
// 장비 -> 가방
UI.el("btnEquipToBag").addEventListener("click", (e)=>{
  stopEvt(e);
  renderAllPanels();
});
// 장비 -> 제작
UI.el("btnEquipCraft").addEventListener("click", (e)=>{
  stopEvt(e);
  // ✅ 선택된 아이템(장비/가방) 있어야 함
  if(!selectedItem) return;
  openPanel("craft");
});


// 가방 -> 장비
UI.el("btnBagToEquip").addEventListener("click", (e)=>{
  stopEvt(e);
  openPanel("equip");
});

// 가방 -> 제작 (선택 아이템을 제작 패널로 자동 전달)
UI.el("btnBagCraft").addEventListener("click", (e)=>{
  stopEvt(e);
  if(!selectedItem) return;

  // ✅ craft 패널 열기
  openPanel("craft");

  // ✅ 제작 선택 아이템 동기화 (장비/가방 whichever selected)
  try{
    if(typeof updateCraftSelectedFromEquipOrBag === "function"){
      updateCraftSelectedFromEquipOrBag();
    }
    if(typeof renderAllPanels === "function"){
      renderAllPanels();
    }
  }catch(err){}
});
const equipToBagBtn = UI.el("btnEquipToBag");

function goBag(e){
  stopEvt(e);
  openPanel("bag");
}

// ✅ iOS 포함 전부 확실하게 먹는 방식
equipToBagBtn.addEventListener("pointerdown", goBag);
equipToBagBtn.addEventListener("click", goBag);
equipToBagBtn.style.touchAction = "manipulation";
UI.el("btnBagEquip").addEventListener("click", (e)=>{
  stopEvt(e);

  if(!selectedItem || selectedItem.from !== "bag") return;
  const it = inventory[selectedItem.idx];
  if(!it || it.isUnique) return;

  equipFromBagToSlot(selectedItem.idx, it.slot);
  renderAllPanels(); // ✅ 화면만 갱신, 패널 이동 없음
});

// ✅ 장비: 선택된 슬롯 해제
UI.el("btnEquipUnequip").addEventListener("click", (e)=>{
  stopEvt(e);

  if(!selectedItem || selectedItem.from !== "equip") return;
  const slot = selectedItem.slot;
  if(!slot || !equipment[slot]) return;

  unequipSlotToBag(slot);
  renderAllPanels(); // ✅ 화면만 갱신, 패널 이동 없음
});
// Close buttons
UI.el("btnEquipClose").addEventListener("click", closePanels);
UI.el("btnBagClose").addEventListener("click", closePanels);
UI.el("btnCraftClose").addEventListener("click", closePanels);
const btnBagEquip = UI.el("btnBagEquip");
if(btnBagEquip){
  btnBagEquip.addEventListener("click", (e)=>{
    stopEvt(e);

    if(!selectedItem || selectedItem.from !== "bag") return;

    const it = inventory[selectedItem.idx];
    if(!it) return;
    if(it.isUnique) return;

    const slot = it.slot;
    if(!slot) return;

    equipFromBagToSlot(selectedItem.idx, slot);

    selectedItem = { from:"equip", slot };
    openPanel("equip");
  });
}
// ESC closes
window.addEventListener("keydown", (e)=>{
  if(e.key === "Escape" && panelOpen) closePanels();
});

/* ============================= */
/* ✅ POE 전용 제작(오브) 시스템  */
/* ============================= */

function rebuildItemInstanceFromAffixes(it, baseId, tmpl, rarity, ilvl, tags, affixes){
  const baseData = buildBaseDataFromItemId(baseId);
  const safeAff = Array.isArray(affixes) ? clampAffixLimits(affixes, rarity) : [];

  const mods = buildItemMods(baseId, baseData, safeAff, tags);
  const affixData = buildAffixDataFromMods(mods);
  const totalData = mergeItemData(baseData, affixData);

  const preNames = safeAff.filter(x=>x.kind==="prefix").map(x=>x.affix.name);
  const sufNames = safeAff.filter(x=>x.kind==="suffix").map(x=>x.affix.name);

  // 이름 규칙(PoE):
  // - normal: 베이스명
  // - magic : (접두) 베이스 (접미)  ※ 접두/접미 각각 최대 1개만 표시
  // - rare  : 레어 전용 2단어 이름(베이스명 대신)
  // - unique: (유니크는 템플릿/아이템에 이미 이름이 있으면 그걸 유지)
  let nm = tmpl.name;

  if(rarity === "magic"){
    const pre = preNames[0] || "";
    const suf = sufNames[0] || "";
    if(pre && suf) nm = pre + " " + nm + " " + suf;
    else if(pre) nm = pre + " " + nm;
    else if(suf) nm = nm + " " + suf;
  }else if(rarity === "rare"){
    nm = rollRareName();
  }else if(rarity === "unique"){
    nm = (it.uniqueName || tmpl.uniqueName || it.name || tmpl.name);
  }

  it.baseId = baseId;
  it.baseName = tmpl.name;
  it.name = nm;
  it.rarity = rarity;
  it.ilvl = ilvl;

  it.baseData = baseData;
  it.tags = tags;
  it.affixes = safeAff;
  it.mods = mods;

  it.affixData = affixData;
  it.totalData = totalData;
  it.data = totalData;

  it.shownDesc = (tmpl.descGen ? tmpl.descGen(totalData) : (it.shownDesc || ""));
}

function setCraftMsg(msg){ try{ const d=UI.el("orbDesc"); if(d) d.textContent=msg; }catch(e){} }

function craftOnSelected(type){
  // ✅ 타락된 아이템은 어떤 크래프팅도 불가능
  try{
    const itLock = (typeof selectedItem!=="undefined" && selectedItem) ? getSelectedItem()
                 : (typeof craftSelectedItem!=="undefined" && craftSelectedItem) ? craftSelectedItem
                 : (typeof currentCraftItem!=="undefined" && currentCraftItem) ? currentCraftItem
                 : null;
    const itCheck = itLock || (typeof getSelectedItem==="function" ? getSelectedItem() : null);
    if(itCheck && itCheck.corrupted){
      const d = UI.el("orbDesc");
      if(d) d.textContent = "타락된 아이템은 크래프팅할 수 없습니다.";
      return;
    }
  }catch(e){}

  const sel = selectedItem;
  if(!sel) return;

  const it = getSelectedItem();
  if(!it) return;
  if(it.isUnique) return;

  const baseId = it.baseId || it.id;
  const tmpl = getItemTemplateById(baseId);
  if(!tmpl) return;

  const ilvl = it.ilvl || getItemLevel();
  const tags = inferItemTagsFromTemplate(tmpl, baseId);

  const curR = it.rarity || "normal";
  const curAff = Array.isArray(it.affixes) ? it.affixes.slice() : [];

  function spend(refName){
    // refName: string variable name
    if(refName === "transmuteOrbs"){ if(transmuteOrbs<=0) return false; transmuteOrbs--; return true; }
    if(refName === "alterationOrbs"){ if(alterationOrbs<=0) return false; alterationOrbs--; return true; }
    if(refName === "augmentationOrbs"){ if(augmentationOrbs<=0) return false; augmentationOrbs--; return true; }
    if(refName === "regalOrbs"){ if(regalOrbs<=0) return false; regalOrbs--; return true; }
    if(refName === "alchemyOrbs"){ if(alchemyOrbs<=0) return false; alchemyOrbs--; return true; }
    if(refName === "chaosOrbs"){ if(chaosOrbs<=0) return false; chaosOrbs--; return true; }
    if(refName === "scouringOrbs"){ if(scouringOrbs<=0) return false; scouringOrbs--; return true; }
    if(refName === "exaltedOrbs"){ if(exaltedOrbs<=0) return false; exaltedOrbs--; return true; }
    if(refName === "annulOrbs"){ if(annulOrbs<=0) return false; annulOrbs--; return true; }
    if(refName === "divineOrbs"){ if(divineOrbs<=0) return false; divineOrbs--; return true; }
    if(refName === "corruptOrbs"){ if(typeof corruptOrbs!=="number"||corruptOrbs<=0) return false; corruptOrbs--; return true; }
    return false;
  }

  let nextR = curR;
  let nextAff = curAff;

  // 제작 규칙(간소화 PoE):
  if(type === "transmute"){
    if(curR !== "normal") return;
    if(!spend("transmuteOrbs")) return;
    nextR = "magic";
    nextAff = rollAffixesPOE("magic", ilvl, tags);
  }
  else if(type === "alter"){
    if(curR !== "magic") return;
    if(!spend("alterationOrbs")) return;
    nextR = "magic";
    nextAff = rollAffixesPOE("magic", ilvl, tags);
  }
  else if(type === "aug"){
    if(curR !== "magic") return;
    if(curAff.length >= 2) return;
    if(!spend("augmentationOrbs")) return;
    nextR = "magic";
    nextAff = rollAffixesPOE("magic", ilvl, tags, { existingAffixes:curAff, keepExisting:true, total: curAff.length+1, add:true });
  }
  else if(type === "regal"){
    if(curR !== "magic") return;
    if(curAff.length < 1) return;
    if(!spend("regalOrbs")) return;
    nextR = "rare";
    nextAff = rollAffixesPOE("rare", ilvl, tags, { existingAffixes:curAff, keepExisting:true, total: curAff.length+1, add:true });
  }
  else if(type === "alchemy"){
    if(curR !== "normal") return;
    if(!spend("alchemyOrbs")) return;
    nextR = "rare";
    nextAff = rollAffixesPOE("rare", ilvl, tags);
  }
  else if(type === "chaos"){
    if(!(curR === "rare" || curR === "rare")) return;
    if(!spend("chaosOrbs")) return;
    nextR = curR;
    nextAff = rollAffixesPOE(nextR, ilvl, tags);
  }
  else if(type === "scour"){
    if(curR === "normal") return;
    if(!spend("scouringOrbs")) return;
    nextR = "normal";
    nextAff = [];
  }
  else if(type === "exalt"){
    if(!(curR === "rare" || curR === "rare")) return;
    if(curAff.length >= maxAffixesForRarity(curR)) return;
    if(!spend("exaltedOrbs")) return;
    nextR = curR;
    nextAff = rollAffixesPOE(nextR, ilvl, tags, { existingAffixes:curAff, keepExisting:true, total: curAff.length+1, add:true });
  }
  else if(type === "annul"){
    if(curAff.length <= 0) return;
    if(!spend("annulOrbs")) return;
    nextR = curR;
    const k = (Math.random()*curAff.length)|0;
    nextAff = curAff.slice();
    nextAff.splice(k, 1);
    // affix가 0이면 normal로 떨어뜨리지는 않음(원하면 바꿀 수 있음)
    if(nextR === "magic" && nextAff.length === 0) nextR = "normal";
  }
  else if(type === "divine"){
    if(curAff.length <= 0) return;
    if(!spend("divineOrbs")) return;
    nextR = curR;
    nextAff = rerollValuesPOE(curAff, ilvl);
  }
  else if(type === "corrupt"){
    // 타락: 아이템에 '타락' 상태만 부여 (이후 크래프팅 불가)
    if(!spend("corruptOrbs")) return;
    it.corrupted = true;
    const d = UI.el("orbDesc");
    if(d) d.textContent = "타락되었습니다.";
    // 즉시 UI 갱신
    renderAllPanels();
    return;
  }


  rebuildItemInstanceFromAffixes(it, baseId, tmpl, nextR, ilvl, tags, nextAff);

  // 장비/가방 위치에 따라 반영 + 스탯 재계산
  if(sel.from === "equip"){
    equipment[sel.slot] = it;
    rebuildGearFromEquipment();
  }

  renderAllPanels();
}

// 버튼 연결
if(btnTransmute) btnTransmute.addEventListener("click", ()=> craftOnSelected("transmute"));
if(btnAlter)     btnAlter.addEventListener("click", ()=> craftOnSelected("alter"));
if(btnAug)       btnAug.addEventListener("click", ()=> craftOnSelected("aug"));
if(btnRegal)     btnRegal.addEventListener("click", ()=> craftOnSelected("regal"));
if(btnAlchemy)   btnAlchemy.addEventListener("click", ()=> craftOnSelected("alchemy"));
if(btnChaos)     btnChaos.addEventListener("click", ()=> craftOnSelected("chaos"));
if(btnScour)     btnScour.addEventListener("click", ()=> craftOnSelected("scour"));
if(btnExalt)     btnExalt.addEventListener("click", ()=> craftOnSelected("exalt"));
if(btnAnnul)     btnAnnul.addEventListener("click", ()=> craftOnSelected("annul"));
if(btnDivine)    btnDivine.addEventListener("click", ()=> craftOnSelected("divine"));

/* ==== 캔버스 터치 ===== */
canvas.addEventListener("touchstart", (e)=>{
  if(gameOver){ resetGame(); return; }

  if(!e.touches || !e.touches[0]) return;
if(handleUltimateOrbPress(e.touches[0].clientX, e.touches[0].clientY)){
    e.preventDefault();
  }
},{passive:false});

canvas.addEventListener("mousedown", (e)=>{
  if(gameOver){ resetGame(); return; }
handleUltimateOrbPress(e.clientX, e.clientY);
});

let lastErr = null;

function drawRuntimeError(e){
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle="rgba(0,0,0,0.75)";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle="#fff";
  ctx.font="bold 16px Arial";
  ctx.textAlign="center";
  ctx.fillText("RUNTIME ERROR (F12 Console 확인)", canvas.width/2, canvas.height/2 - 10);
  ctx.font="14px Arial";
  ctx.fillText(String(e && e.message ? e.message : e), canvas.width/2, canvas.height/2 + 18);
}

function loop(){
  try{
    if(gameOver){
      drawGameOver();
    }else if(gamePaused){
      // ✅ 정지 화면(딤/블러 캡쳐)을 계속 보여주기만
      ctx.setTransform(1,0,0,1,0,0);
      ctx.globalAlpha = 1;
      ctx.filter = "none";
      ctx.drawImage(pauseCanvas, 0, 0);
        }else{
      update();
      draw();

      if(resumeFade > 0){
        const a = resumeFade / resumeFadeMax;
        ctx.setTransform(1,0,0,1,0,0);
        ctx.globalAlpha = a;
        ctx.filter = "none";
        ctx.drawImage(pauseCanvas, 0, 0);
        ctx.globalAlpha = 1;
        resumeFade--;
      }
    }
    lastErr = null;
  }catch(e){
    console.error(e);
    lastErr = e;
    drawRuntimeError(e);
  }finally{
    /* RAF owned by app.js */
  }
}

/* ===== 공격 아이콘 ===== */
const iconCanvas = UI.el("attackIcon");
const iconCtx = iconCanvas.getContext("2d");
iconCtx.clearRect(0, 0, 60, 60);
iconCtx.save();
iconCtx.translate(30, 34);
iconCtx.scale(1.4, 1.4);
drawSwordShape(iconCtx);
iconCtx.restore();

function resetGame(){
  document.body.classList.remove('gameover');

  mapTier = 1;


  // ✅ 인벤/장비/유니크 초기화
  inventory = [];
  equipment = { weapon:null, helm:null, chest:null, ring:null };
  selectedItem = null;
  panelOpen = null;
  chaosOrbs = 2;
  ownedUniques = [];
  uniqueState = {};
  if(audioUnlocked && !bgmOsc){
    bgmOsc = startBGM();
  }

  player.baseMaxHp = 100;
  player.maxHp = 100;
  player.hp = 100;

  player.baseArmor = 0;
  player.armor = 0;
  player.invul = 0;
  player.kiOrbs = 0;
  player.ultiActive = false;
  player.ultiCount = 0;
  player.ultiTimer = 0;
  player.levelGlow = 0;

  killCount = 0;
  level = 1;
  killsAtLevelStart = 0;
  killsForNextLevel = 20;
  baseDamageBase = 20;
  ultiDamageBase = 40;

  player.gear = {
    armorAdd: 0, maxHpAdd: 0, hpRegen: 0,
    critChanceAdd: 0, critChanceMul: 1, critMultiAdd: 0
  };

  recalcFromGear();

  shake = 0;
  slowMotion = 0;
  gameOver = false;
  UI.el("ui").style.display = "flex";
  // ✅ 게임 재시작 시 HUD 버튼 복구
  ["miniBagBtn","lootBtn"].forEach(id=>{
    const el=UI.el(id);
    if(el) el.style.display="flex";
  });
  ["hudBtns","btnBag","btnEquip"].forEach(id=>{
    const el=UI.el(id);
    if(el) el.style.display="";
  });

  startNewMap(1);


  // ✅ 스타터 아이템 지급(아이템이 안 보이는 느낌 방지)
  giveStarterItems();
  closePanels();
  resize();

  // 루트/UI 리셋
  loots = [];
  lootOverlayOpen = false;
  pendingLoot = null;
  lootOverlay.style.display = "none";
}
// ===============================
// ✅ FAILSAFE: pickItemsForChoice 절대 크래시 방지 래퍼
// ===============================
(function(){
  if(typeof pickItemsForChoice !== "function") return;
  const __origPick = pickItemsForChoice;

  window.pickItemsForChoice = function(count){
    try{
      const out = __origPick(count);
      return Array.isArray(out) ? out.filter(Boolean) : [];
    }catch(e){
      console.warn("pickItemsForChoice CRASH BLOCKED:", e);
      return [];
    }
  };
})();
// ===============================
// ✅ DROP FIX: slot/tier/ilvl 기본 구현 (없으면 자동 제공)
// ===============================

function __randPickWeighted(pairs){
  // pairs: [{v, w}]
  let sum = 0;
  for(const p of pairs){ sum += Math.max(0, p.w||0); }
  if(sum <= 0) return pairs[0]?.v;
  let r = Math.random() * sum;
  for(const p of pairs){
    r -= Math.max(0, p.w||0);
    if(r <= 0) return p.v;
  }
  return pairs[pairs.length-1]?.v;
}

// 1) 슬롯 분포 (PoE 느낌: 초반 무기/갑옷 위주, 후반 반지/기타도 섞임)
if(typeof pickSlotForMapTier !== "function"){
  window.pickSlotForMapTier = function(mapTier){
    const t = Math.max(1, mapTier||1);
    // weapon, chest, helm, boots, ring
    if(t <= 2){
      return __randPickWeighted([
        {v:"weapon", w:45},
        {v:"chest",  w:25},
        {v:"helm",   w:15},
        {v:"boots",  w:10},
        {v:"ring",   w:5},
      ]);
    }
    if(t <= 6){
      return __randPickWeighted([
        {v:"weapon", w:35},
        {v:"chest",  w:25},
        {v:"helm",   w:15},
        {v:"boots",  w:12},
        {v:"ring",   w:13},
      ]);
    }
    return __randPickWeighted([
      {v:"weapon", w:28},
      {v:"chest",  w:22},
      {v:"helm",   w:15},
      {v:"boots",  w:13},
      {v:"ring",   w:22},
    ]);
  };
}

// 2) 베이스 티어 분포 (mapTier가 오를수록 상위 tier 비중 증가)
if(typeof pickBaseTierForMap !== "function"){
  window.pickBaseTierForMap = function(mapTier){
    const t = Math.max(1, mapTier||1);
    // baseTier: 1~5 기준
    if(t <= 2)  return __randPickWeighted([{v:1,w:80},{v:2,w:20}]);
    if(t <= 4)  return __randPickWeighted([{v:1,w:45},{v:2,w:35},{v:3,w:20}]);
    if(t <= 6)  return __randPickWeighted([{v:1,w:20},{v:2,w:30},{v:3,w:30},{v:4,w:20}]);
    if(t <= 8)  return __randPickWeighted([{v:2,w:20},{v:3,w:35},{v:4,w:30},{v:5,w:15}]);
    return __randPickWeighted([{v:3,w:25},{v:4,w:35},{v:5,w:40}]);
  };
}

// 3) ilvl 스케일 (맵티어 상승 → ilvl 상승)
if(typeof rollItemLevelFromMapTier !== "function"){
  window.rollItemLevelFromMapTier = function(mapTier){
    const t = Math.max(1, mapTier||1);
    // 예: t=1 → 1~8, t=5 → 21~28, t=10 → 46~55
    const base = (t-1)*5 + 1;
    const jitter = Math.floor(Math.random()*8); // 0~7
    return base + jitter;
  };
}

/* =========================
   PoE식 태그 기반 AFFIX POOL
   (궁극기 피해 옵션 제거됨)
   ========================= */

const AFFIX_POOL = {
  weapon: {
    prefix: [
      { id:"p_brutal", name:"잔혹한", stat:"damage", op:"inc", value:0.20, requiresAll:["melee"] },
      { id:"p_rage", name:"격노의", stat:"damage", op:"more", value:0.15, requiresAll:["elite"] },
      { id:"p_slayer", name:"학살의", stat:"damage", op:"inc", value:0.25, requiresAll:["boss"] },
      { id:"p_piercing", name:"관통의", stat:"damage", op:"inc", value:0.20, requiresAll:["projectile"] },
      { id:"p_flame", name:"연소의", stat:"damage", op:"inc", value:0.18, requiresAll:["fire"] },
      { id:"p_frost", name:"빙결의", stat:"damage", op:"inc", value:0.18, requiresAll:["cold"] },
      { id:"p_lightning", name:"번개의", stat:"damage", op:"inc", value:0.18, requiresAll:["lightning"] },
      { id:"p_swift", name:"질풍의", stat:"damage", op:"inc", value:0.15, requiresAll:["attack"] },
      { id:"p_vicious", name:"맹독의", stat:"damage", op:"inc", value:0.22, requiresAll:["enemy"] },
      { id:"p_destroyer", name:"파괴의", stat:"damage", op:"more", value:0.20, requiresAll:["high_tier"] }
    ],
    suffix: [
      { id:"s_assassin", name:"암살자의", stat:"damage", op:"more", value:0.25, requiresAll:["crit"] },
      { id:"s_hunter", name:"사냥꾼의", stat:"damage", op:"inc", value:0.20, requiresAll:["elite"] },
      { id:"s_conqueror", name:"정복자의", stat:"damage", op:"inc", value:0.25, requiresAll:["boss"] },
      { id:"s_flare", name:"…의 화염", stat:"damage", op:"inc", value:0.15, requiresAll:["fire"] },
      { id:"s_storm", name:"…의 폭풍", stat:"damage", op:"inc", value:0.15, requiresAll:["lightning"] },
      { id:"s_wave", name:"…의 파동", stat:"damage", op:"inc", value:0.15, requiresAll:["aoe"] },
      { id:"s_precision", name:"정밀의", stat:"damage", op:"inc", value:0.10, requiresAll:["projectile"] },
      { id:"s_slayer2", name:"…의 학살", stat:"damage", op:"more", value:0.15, requiresAll:["melee"] },
      { id:"s_void", name:"…의 심연", stat:"damage", op:"more", value:0.20, requiresAll:["high_tier"] },
      { id:"s_ruin", name:"…의 파멸", stat:"damage", op:"more", value:0.18, requiresAll:["enemy"] }
    ]
  },

  armor: {
    prefix: [
      { id:"ap_giant", name:"거인의", stat:"max_hp", op:"add", value:150 },
      { id:"ap_steel", name:"강철의", stat:"armor", op:"add", value:80 },
      { id:"ap_guardian", name:"수호의", stat:"player_damage_taken", op:"inc", value:-0.10, requiresAll:["projectile"] },
      { id:"ap_fortress", name:"요새의", stat:"player_damage_taken", op:"inc", value:-0.15, requiresAll:["boss"] },
      { id:"ap_resist", name:"정화의", stat:"player_damage_taken", op:"inc", value:-0.10, requiresAll:["fire"] },
      { id:"ap_regen", name:"재생의", stat:"hp_regen", op:"add", value:5 },
      { id:"ap_endurance", name:"인내의", stat:"player_damage_taken", op:"inc", value:-0.08 },
      { id:"ap_barrier", name:"결계의", stat:"player_damage_taken", op:"inc", value:-0.12, requiresAll:["spell"] },
      { id:"ap_titan", name:"거대화의", stat:"max_hp", op:"more", value:0.10 },
      { id:"ap_hardened", name:"강인한", stat:"armor", op:"more", value:0.15 }
    ],
    suffix: [
      { id:"as_vitality", name:"…의 활력", stat:"max_hp", op:"add", value:100 },
      { id:"as_wall", name:"…의 장벽", stat:"armor", op:"add", value:60 },
      { id:"as_survivor", name:"…의 생존자", stat:"player_damage_taken", op:"inc", value:-0.10 },
      { id:"as_guard", name:"…의 수호자", stat:"player_damage_taken", op:"inc", value:-0.12, requiresAll:["boss"] },
      { id:"as_swift", name:"…의 민첩", stat:"move_speed", op:"inc", value:0.10 },
      { id:"as_reflect", name:"…의 반격", stat:"damage_taken", op:"inc", value:-0.05 },
      { id:"as_focus", name:"…의 집중", stat:"hp_regen", op:"add", value:3 },
      { id:"as_absorb", name:"…의 흡수", stat:"player_damage_taken", op:"inc", value:-0.07 },
      { id:"as_stone", name:"…의 암석", stat:"armor", op:"more", value:0.10 },
      { id:"as_eternal", name:"…의 영원", stat:"max_hp", op:"more", value:0.08 }
    ]
  }
};
  
function getCorruptImplicitPool(tags){
  // 간단 타락 임플릿 풀 (PoE 느낌)
  // tags는 inferItemTagsFromTemplate 결과(weapon/melee/spell/armor/ring 등)
  const pool = [];
  const isWeapon = tags.includes("weapon");
  const isArmor  = tags.includes("armor");
  const isRing   = tags.includes("ring");

  // 공통
  pool.push({ text:"+%d%% 최대 생명력", stat:"max_hp", op:"inc", value:0.06 });
  pool.push({ text:"+%d%% 치명타 확률", stat:"crit", op:"inc", value:0.05 });
  pool.push({ text:"+%d%% 치명타 피해", stat:"critDmg", op:"inc", value:0.12 });

  if(isWeapon){
    pool.push({ text:"+%d%% 공격 속도", stat:"atkSpd", op:"inc", value:0.06 });
    pool.push({ text:"+%d%% 범위", stat:"range", op:"inc", value:0.08 });
    pool.push({ text:"추가 물리 피해 +%d", stat:"physAddedMin", op:"add", value:2, pairStat:"physAddedMax", pairValue:3 });
  }
  if(isArmor){
    pool.push({ text:"+%d%% 방어도", stat:"armor", op:"inc", value:0.10 });
    pool.push({ text:"+%d 모든 저항", stat:"resAll", op:"add", value:6 });
    pool.push({ text:"+%d%% 이동 속도", stat:"moveSpd", op:"inc", value:0.06 });
  }
  if(isRing){
    pool.push({ text:"+%d 화염 저항", stat:"resFire", op:"add", value:8 });
    pool.push({ text:"+%d 냉기 저항", stat:"resCold", op:"add", value:8 });
    pool.push({ text:"+%d 번개 저항", stat:"resLightning", op:"add", value:8 });
  }
  return pool;
}

function destroySelectedItem(){
  const ref = getSelectedItemRef();
  if(!ref) return;
  // equip 슬롯이면 비움, bag 슬롯이면 제거
  if(ref.kind==="equip"){
    equips[ref.slot] = null;
  }else if(ref.kind==="bag"){
    bag[ref.index] = null;
  }
  selectedItem = null;
}
// (moved to app.js boot)
/* =========================================
   POE 메타 크래프팅 시스템 (FULL INTEGRATED)
   - 접두 고정 / 접미 고정 토글
   - 메타 제거(엑잘 3)
   - 패널 렌더 훅(안전 오버라이드)
   - 아이템 설명창에 한글 표시(하늘색)
========================================= */
(function(){

function ensureMetaCraftUI(){
  const orbDescEl = UI.el("orbDesc");
  if(!orbDescEl) return;
  if(UI.el("metaCraftBox")) return;

  const box = document.createElement("div");
  box.id = "metaCraftBox";
  box.style.marginBottom = "8px";
  box.style.padding = "8px";
  box.style.border = "1px solid rgba(255,255,255,0.12)";
  box.style.borderRadius = "12px";
  box.style.background = "rgba(0,0,0,0.25)";
  box.style.display = "grid";
  box.style.gridTemplateColumns = "1fr 1fr";
  box.style.gap = "8px";

  // 버튼 기본 스타일(기존 CSS 안 건드리고 인라인로만)
  const btnStyle = "padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,0.14);background:#202020;color:#f2f2f2;font-weight:900;";
  const btnDanger = "padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,0.14);background:#2a1010;color:#ffd166;font-weight:900;";

  box.innerHTML = `
    <button id="btnLockPrefix" style="${btnStyle}">접두 고정 (OFF)</button>
    <button id="btnLockSuffix" style="${btnStyle}">접미 고정 (OFF)</button>
    <button id="btnRemoveMeta" style="grid-column:1 / span 2;${btnDanger}">메타 제거 (엑잘 3)</button>
`;

  // ✅ 메타 UI는 오브 버튼 바로 위에 배치 (한 화면에 최대한 보이게)
  const orbGrid = UI.el("craftOrbGrid");
  if(orbGrid && orbGrid.parentNode){
    orbGrid.parentNode.insertBefore(box, orbGrid.nextSibling);
  }else{
    orbDescEl.parentNode.insertBefore(box, orbDescEl);
  }

  UI.el("btnLockPrefix").onclick = ()=>{
    const it = (typeof getSelectedItem === "function") ? getSelectedItem() : null;
    if(!it || it.isUnique) return;
    it.metaCraft = it.metaCraft || {lockPrefix:false,lockSuffix:false};
    it.metaCraft.lockPrefix = !it.metaCraft.lockPrefix;
    if(typeof renderAllPanels === "function") renderAllPanels();
  };

  UI.el("btnLockSuffix").onclick = ()=>{
    const it = (typeof getSelectedItem === "function") ? getSelectedItem() : null;
    if(!it || it.isUnique) return;
    it.metaCraft = it.metaCraft || {lockPrefix:false,lockSuffix:false};
    it.metaCraft.lockSuffix = !it.metaCraft.lockSuffix;
    if(typeof renderAllPanels === "function") renderAllPanels();
  };

  UI.el("btnRemoveMeta").onclick = ()=>{
    const it = (typeof getSelectedItem === "function") ? getSelectedItem() : null;
    if(!it || it.isUnique) return;
    it.metaCraft = it.metaCraft || {lockPrefix:false,lockSuffix:false};
    if(!it.metaCraft.lockPrefix && !it.metaCraft.lockSuffix) return;

    if(typeof exaltedOrbs !== "number" || exaltedOrbs < 3) return;
    exaltedOrbs -= 3;

    it.metaCraft.lockPrefix = false;
    it.metaCraft.lockSuffix = false;

    if(typeof renderAllPanels === "function") renderAllPanels();
  };
}

function renderMetaCraftUI(){
  ensureMetaCraftUI();

  const it = (typeof getSelectedItem === "function") ? getSelectedItem() : null;
  const p = UI.el("btnLockPrefix");
  const s = UI.el("btnLockSuffix");
  const r = UI.el("btnRemoveMeta");

  if(!it || it.isUnique){
    if(p) p.disabled = true;
    if(s) s.disabled = true;
    if(r) r.disabled = true;
    return;
  }

  it.metaCraft = it.metaCraft || {lockPrefix:false,lockSuffix:false};

  if(p) p.textContent = `접두 고정 (${it.metaCraft.lockPrefix ? "ON" : "OFF"})`;
  if(s) s.textContent = `접미 고정 (${it.metaCraft.lockSuffix ? "ON" : "OFF"})`;

  if(r){
    const metaOn = it.metaCraft.lockPrefix || it.metaCraft.lockSuffix;
    const enough = (typeof exaltedOrbs === "number" && exaltedOrbs >= 3);
    r.disabled = !(metaOn && enough);
    r.style.opacity = r.disabled ? "0.55" : "1";
  }
}

// renderAllPanels 훅(기존 함수는 유지)
if(typeof renderAllPanels === "function"){
  const _origRenderAllPanels = renderAllPanels;
  renderAllPanels = function(){
    _origRenderAllPanels();
    try{ renderMetaCraftUI(); }catch(e){}
  };
}

// prettyItemHTML 훅(기존 함수는 유지)
// - 원본 함수가 만드는 HTML 블록 안에 "메타" 라인을 끼워 넣음
if(typeof prettyItemHTML === "function"){
  const _origPretty = prettyItemHTML;
  prettyItemHTML = function(it){
    let html = _origPretty(it);

    if(it && it.metaCraft && (it.metaCraft.lockPrefix || it.metaCraft.lockSuffix)){
      const insert = `
        <div class="itemInfoGap"></div>
        <div class="itemInfoLine itemInfoDim">메타</div>
        ${it.metaCraft.lockPrefix ? '<div class="itemInfoLine itemInfoMeta">- 접두 고정</div>' : ''}
        ${it.metaCraft.lockSuffix ? '<div class="itemInfoLine itemInfoMeta">- 접미 고정</div>' : ''}
      `;
      // 가장 마지막 </div> 앞에 넣기 (원본이 itemInfoWrap을 div로 닫는 구조라고 가정)
      const idx = html.lastIndexOf("</div>");
      if(idx !== -1){
        html = html.slice(0, idx) + insert + html.slice(idx);
      }else{
        html += insert;
      }
    }

    return html;
  };
}

})(); 


/* ===== Craft Apply Mode: 오브는 선택만, 적용은 상단 [제작]으로만 ===== */
(function(){
  if(window.__craftApplyOnly) return;
  window.__craftApplyOnly = true;

  window.craftSelectedOrb = window.craftSelectedOrb || null;

  function getCountByType(t){
    try{
      switch(t){
        case "transmute": return (typeof transmuteOrbs==="number") ? transmuteOrbs : 0;
        case "alter":     return (typeof alterationOrbs==="number") ? alterationOrbs : 0;
        case "aug":       return (typeof augmentationOrbs==="number") ? augmentationOrbs : 0;
        case "regal":     return (typeof regalOrbs==="number") ? regalOrbs : 0;
        case "alchemy":   return (typeof alchemyOrbs==="number") ? alchemyOrbs : 0;
        case "chaos":     return (typeof chaosOrbs==="number") ? chaosOrbs : 0;
        case "scour":     return (typeof scouringOrbs==="number") ? scouringOrbs : 0;
        case "exalt":     return (typeof exaltedOrbs==="number") ? exaltedOrbs : 0;
        case "annul":     return (typeof annulOrbs==="number") ? annulOrbs : 0;
        case "divine":    return (typeof divineOrbs==="number") ? divineOrbs : 0;
        case "corrupt":   return (typeof corruptOrbs==="number") ? corruptOrbs : 0;
        default: return 0;
      }
    }catch(e){ return 0; }
  }
  function setDesc(msg){
    const d = UI.el("orbDesc");
    if(d) d.textContent = msg;
  }


  function stop(e){
    try{ if(typeof stopEvt==="function") stopEvt(e); }catch(_){}
    try{ e.preventDefault(); e.stopPropagation(); }catch(_){}
  }

  function typeFromId(id){
    switch(id){
      case "orbTransmute": return "transmute";
      case "orbAlter": return "alter";
      case "orbAug": return "aug";
      case "orbRegal": return "regal";
      case "orbAlchemy": return "alchemy";
      case "chaosBtn": return "chaos";
      case "orbScour": return "scour";
      case "orbExalt": return "exalt";
      case "orbAnnul": return "annul";
      case "orbDivine": return "divine";
      case "orbCorrupt": return "corrupt";
      default: return null;
    }
  }

  function setActive(btn){
    const grid = UI.el("craftOrbGrid");
    if(!grid) return;
    grid.querySelectorAll("button.orbBtn").forEach(b=>b.classList.remove("active"));
    if(btn) btn.classList.add("active");
  }

  function selectOrb(btn){
    const t = typeFromId(btn.id);
    if(!t) return;
    window.craftSelectedOrb = t;
    setActive(btn);
    const d = UI.el("orbDesc");
    /* 선택됨 문구 제거 */
  }

  function bindOrbs(){
    const grid = UI.el("craftOrbGrid");
    if(!grid) return;
    grid.querySelectorAll("button.orbBtn").forEach(btn=>{
      if(btn.__selectOnlyBound) return;
      btn.__selectOnlyBound = true;
      btn.onclick = null;
      btn.addEventListener("click", (e)=>{
        stop(e);
        selectOrb(btn);
      }, true);
    });
  }

  function bindTop(){
    const toEquip = UI.el("btnCraftToEquip");
    const toBag   = UI.el("btnCraftToBag");
    const apply   = UI.el("btnCraftApply");
    const close   = UI.el("btnCraftClose");

    if(toEquip && !toEquip.__b){
      toEquip.__b = true;
      toEquip.addEventListener("click", (e)=>{ stop(e); if(typeof openPanel==="function") openPanel("equip"); });
    }
    if(toBag && !toBag.__b){
      toBag.__b = true;
      toBag.addEventListener("click", (e)=>{ stop(e); if(typeof openPanel==="function") openPanel("bag"); });
    }
    if(apply && !apply.__b){
      apply.__b = true;
      apply.addEventListener("click", (e)=>{
        stop(e);
        const t = window.craftSelectedOrb;
        if(!t){ setDesc("오브를 먼저 선택하세요."); return; }
        const before = getCountByType(t);
        if(typeof craftOnSelected==="function") craftOnSelected(t);
        const after = getCountByType(t);
        if(after < before) setDesc("사용 완료!");
        else setDesc("사용 실패: 조건/오브 확인");
        try{ if(typeof renderAllPanels==="function") renderAllPanels(); }catch(_){ }
      });
    }
    if(close && !close.__b){
      close.__b = true;
      close.addEventListener("click", (e)=>{ stop(e); if(typeof closeAllPanels==="function") closeAllPanels(); });
    }
  }

  if(typeof renderAllPanels === "function"){
    const _orig = renderAllPanels;
    renderAllPanels = function(){
      _orig();
      try{ bindOrbs(); bindTop(); }catch(_){}
      try{
        const grid = UI.el("craftOrbGrid");
        if(grid && window.craftSelectedOrb){
          const map = {transmute:"orbTransmute",alter:"orbAlter",aug:"orbAug",regal:"orbRegal",alchemy:"orbAlchemy",chaos:"chaosBtn",scour:"orbScour",exalt:"orbExalt",annul:"orbAnnul",divine:"orbDivine",corrupt:"orbCorrupt"};
          const btn = grid.querySelector("#"+(map[window.craftSelectedOrb]||""));
          if(btn) setActive(btn);
        }
      }catch(_){}
    };
  }

  try{ bindOrbs(); bindTop(); }catch(_){}
})();


/* ===== Craft Orbs: 아이템 아이콘 스타일로 렌더 (캔버스) ===== */
(function(){
  if(window.__orbIconStyleV1) return;
  window.__orbIconStyleV1 = true;

  function getCountById(id){
    try{
      switch(id){
        case "orbTransmute": return (typeof transmuteOrbs==="number") ? transmuteOrbs : 0;
        case "orbAlter":     return (typeof alterationOrbs==="number") ? alterationOrbs : 0;
        case "orbAug":       return (typeof augmentationOrbs==="number") ? augmentationOrbs : 0;
        case "orbRegal":     return (typeof regalOrbs==="number") ? regalOrbs : 0;
        case "orbAlchemy":   return (typeof alchemyOrbs==="number") ? alchemyOrbs : 0;
        case "chaosBtn":     return (typeof chaosOrbs==="number") ? chaosOrbs : 0;
        case "orbScour":     return (typeof scouringOrbs==="number") ? scouringOrbs : 0;
        case "orbExalt":     return (typeof exaltedOrbs==="number") ? exaltedOrbs : 0;
        case "orbAnnul":     return (typeof annulOrbs==="number") ? annulOrbs : 0;
        case "orbDivine":    return (typeof divineOrbs==="number") ? divineOrbs : 0;
        case "orbCorrupt":   return (typeof corruptOrbs==="number") ? corruptOrbs : 0;
        default: return 0;
      }
    }catch(e){ return 0; }
  }

  function rarityForOrb(id){
    // 색 규칙을 "희귀도 테두리"로 치환 (drawItemIcon의 테두리 색 사용)
    // normal=흰, magic=파, rare=금, unique=주황
    if(id==="orbTransmute" || id==="orbAlter" || id==="orbAug") return "magic";           // 파란 계열
    if(id==="orbRegal") return "rare";                                                   // 금(제왕: 금+파는 코어에서 표현)
    if(id==="orbAlchemy") return "rare";                                                 // 금쪽 (연금은 코어/심볼로 은+금 느낌)
    if(id==="chaosBtn" || id==="orbExalt" || id==="orbDivine") return "rare";            // 금
    if(id==="orbScour") return "normal";                                                 // 흰
    if(id==="orbAnnul") return "magic";                                                  // 코발트 느낌은 코어로
    if(id==="orbCorrupt") return "unique";                                               // 타락(붉은 주황 계열)
    return "normal";
  }

  function drawOrbIcon(canvas, id){
    const g = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    g.clearRect(0,0,W,H);

    // 배경(아이템 아이콘 스타일)
    g.fillStyle = "rgba(0,0,0,0.18)";
    g.fillRect(0,0,W,H);

    // 테두리(희귀도 색)
    const rr = rarityForOrb(id);
    g.lineWidth = 3;
    if(rr==="unique") g.strokeStyle = "#ffb86b";
    else if(rr==="rare") g.strokeStyle = "#ffd166";
    else if(rr==="magic") g.strokeStyle = "#2f7bff";
    else g.strokeStyle = "#ffffff";
    const pad = 4;
    g.strokeRect(pad, pad, W-pad*2, H-pad*2);

    // 중앙: "오니 머리" 실루엣(기존 아이템 캔버스 스타일에 맞춘 단순 실루엣)
    // (이미지 없이, 도형으로만)
    g.save();
    g.translate(W/2, H/2 - 2);

    // 코어 컬러
    let core = "#2a2a2a";
    if(id==="orbTransmute" || id==="orbAlter" || id==="orbAug") core = "#2f7bff";
    if(id==="orbRegal") core = "#c8a23a";
    if(id==="orbAlchemy") core = "#d8d8d8";
    if(id==="chaosBtn" || id==="orbExalt" || id==="orbDivine") core = "#b88a2a";
    if(id==="orbScour") core = "#f0f0f0";
    if(id==="orbAnnul") core = "#2a66ff";
    if(id==="orbCorrupt") core = "#c23a2a";

    // 은은한 코어 광
    const rg = g.createRadialGradient(0,-10,6, 0,-10, 34);
    rg.addColorStop(0, "rgba(255,255,255,0.28)");
    rg.addColorStop(0.25, core + "AA");
    rg.addColorStop(1, "rgba(0,0,0,0.0)");
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0,0,32,0,Math.PI*2);
    g.fill();

    // 오니 얼굴(마스크) - 다크 메탈 + 코어 하이라이트
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.strokeStyle = "rgba(255,255,255,0.20)";
    g.lineWidth = 2;

    // 얼굴
    g.beginPath();
    g.moveTo(0,-22);
    g.quadraticCurveTo(22,-18, 20,0);
    g.quadraticCurveTo(18,22, 0,24);
    g.quadraticCurveTo(-18,22, -20,0);
    g.quadraticCurveTo(-22,-18, 0,-22);
    g.closePath();
    g.fill(); g.stroke();

    // 뿔
    g.fillStyle = "rgba(0,0,0,0.65)";
    g.beginPath();
    g.moveTo(-10,-20); g.lineTo(-26,-32); g.lineTo(-16,-10); g.closePath();
    g.moveTo(10,-20);  g.lineTo(26,-32);  g.lineTo(16,-10);  g.closePath();
    g.fill();

    // 눈(코어색)
    g.fillStyle = core;
    g.shadowColor = core;
    g.shadowBlur = 8;
    g.beginPath(); g.arc(-8,-2,3,0,Math.PI*2); g.fill();
    g.beginPath(); g.arc(8,-2,3,0,Math.PI*2); g.fill();
    g.shadowBlur = 0;

    g.restore();
  }

  function ensure(){
    const grid = UI.el("craftOrbGrid");
    if(!grid) return;

    grid.querySelectorAll("button.orbBtn").forEach(btn=>{
      // 캔버스
      let c = btn.querySelector("canvas.orbIcon");
      if(!c){
        c = document.createElement("canvas");
        c.className = "orbIcon";
        c.width = 84; c.height = 84;
        btn.prepend(c);
      }
      // 수량
      let n = btn.querySelector(".orbMiniCount");
      if(!n){
        n = document.createElement("div");
        n.className = "orbMiniCount";
        btn.appendChild(n);
      }
      n.textContent = String(getCountById(btn.id));

      // 아이콘 그리기
      try{ drawOrbIcon(c, btn.id); }catch(e){}
    });
  }

  // 렌더 타이밍: 패널 갱신마다
  if(typeof renderAllPanels==="function"){
    const _orig = renderAllPanels;
    renderAllPanels = function(){
      _orig();
      try{ ensure(); }catch(_){}
    };
  }

  try{ ensure(); }catch(_){}
})();


/* ===== Corruption marker: 아이템 스탯 맨 하단에 '타락' 표시 ===== */
(function(){
  if(window.__corruptionMarkerV2) return;
  window.__corruptionMarkerV2 = true;

  function getIt(){
    try{
      if(typeof getSelectedItem==="function"){
        const it = getSelectedItem();
        if(it) return it;
      }
      if(typeof selectedItem!=="undefined" && selectedItem && selectedItem.item) return selectedItem.item;
    }catch(e){}
    return null;
  }

  function apply(){
    const it = getIt();
    if(!it || !it.corrupted) return;
    const el = UI.el("craftItemText");
    if(el && el.innerHTML && !el.innerHTML.includes('>타락<')){
      el.innerHTML += '<div style="margin-top:6px;color:#ff5b5b;font-weight:900;text-shadow:0 0 10px rgba(255,80,80,0.25);">타락</div>';
    }
  }

  if(typeof renderAllPanels==="function"){
    const _orig = renderAllPanels;
    renderAllPanels = function(){
      _orig();
      try{ apply(); }catch(e){}
    };
  }

  try{ apply(); }catch(e){}
})();


/* ===== Orb touchstart binding (iOS) ===== */
(function(){
  if(window.__orbTouchStart) return;
  window.__orbTouchStart = true;

  function stop(e){
    try{ if(typeof stopEvt==="function") stopEvt(e); }catch(_){}
    try{ e.preventDefault(); e.stopPropagation(); }catch(_){}
  }

  function typeFromId(id){
    switch(id){
      case "orbTransmute": return "transmute";
      case "orbAlter": return "alter";
      case "orbAug": return "aug";
      case "orbRegal": return "regal";
      case "orbAlchemy": return "alchemy";
      case "chaosBtn": return "chaos";
      case "orbScour": return "scour";
      case "orbExalt": return "exalt";
      case "orbAnnul": return "annul";
      case "orbDivine": return "divine";
      case "orbCorrupt": return "corrupt";
      default: return null;
    }
  }

  function setActive(btn){
    const grid = UI.el("craftOrbGrid");
    if(!grid) return;
    grid.querySelectorAll("button.orbBtn").forEach(b=>b.classList.remove("active"));
    if(btn) btn.classList.add("active");
  }

  function selectOrb(btn){
    const t = typeFromId(btn.id);
    if(!t) return;
    window.craftSelectedOrb = t;
    setActive(btn);
  }

  function bind(){
    const grid = UI.el("craftOrbGrid");
    if(!grid) return;
    grid.querySelectorAll("button.orbBtn").forEach(btn=>{
      if(btn.__touchBound) return;
      btn.__touchBound = true;
      btn.addEventListener("touchstart", (e)=>{ stop(e); selectOrb(btn); }, {capture:true, passive:false});
    });
  }

  if(typeof renderAllPanels==="function"){
    const _orig = renderAllPanels;
    renderAllPanels = function(){
      _orig();
      try{ bind(); }catch(_){}
    };
  }
  try{ bind(); }catch(_){}
})();


/* ===== Orb description on select ===== */
(function(){
  if(window.__orbDescV1) return;
  window.__orbDescV1 = true;

  function descFor(type){
    switch(type){
      case "transmute": return "진화: 노멀 아이템을 매직으로 변경";
      case "alter":     return "변화: 매직 아이템 옵션 재굴림";
      case "aug":       return "확장: 매직 아이템에 옵션 1개 추가(최대 2개)";
      case "regal":     return "제왕: 매직 아이템을 레어로 승급 + 옵션 1개 추가";
      case "alchemy":   return "연금: 노멀 아이템을 레어로 변경";
      case "chaos":     return "카오스: 레어 아이템 옵션 재굴림(4~6개)";
      case "scour":     return "정제: 아이템을 노멀로 되돌림(옵션 제거)";
      case "exalt":     return "엑잘: 레어 아이템에 옵션 1개 추가(최대 6개)";
      case "annul":     return "소멸: 아이템 옵션 1개 제거";
      case "divine":    return "신성: 옵션 수치 재굴림(구현 상태에 따라 다름)";
      case "corrupt":   return "타락: 아이템에 '타락' 부여 (이후 크래프팅 불가)";
      default: return "오브를 선택하면 설명이 표시됩니다.";
    }
  }

  function updateDesc(){
    const d = UI.el("orbDesc");
    if(!d) return;
    const t = window.craftSelectedOrb;
    d.textContent = descFor(t);
  }

  // Hook selection: when active changes, update
  const origSet = window.__setActiveOrbBtn;
  // We'll just poll on renderAllPanels and whenever selected changes
  if(typeof renderAllPanels==="function"){
    const _orig = renderAllPanels;
    renderAllPanels = function(){
      _orig();
      try{ updateDesc(); }catch(_){}
    };
  }
  // Also run frequently after touch/click
  document.addEventListener("click", ()=>setTimeout(updateDesc,0), true);
  document.addEventListener("touchstart", ()=>setTimeout(updateDesc,0), {capture:true, passive:true});

  try{ updateDesc(); }catch(_){}
})();


/* mini bag safe handler */
(function(){
  if(window.__miniBagSafeV1) return;
  window.__miniBagSafeV1 = true;
  const b = UI.el("miniBagBtn");
  if(!b) return;
  function stop(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} }
  function openBag(){
    try{
      if(typeof openPanel==="function") openPanel("bag");
      else if(typeof bagBtn!=="undefined" && bagBtn.click) bagBtn.click();
    }catch(_){}
  }
  b.addEventListener("click", (e)=>{ stop(e); openBag(); });
  b.addEventListener("touchstart", (e)=>{ stop(e); openBag(); }, {passive:false});
})();

/* safe loot button */
(function(){
  if(window.__lootSafeV1) return;
  window.__lootSafeV1 = true;
  const btn = UI.el("lootBtn");
  if(!btn) return;
  function stop(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} }
  function tryLoot(){
    try{
      if(typeof getNearbyLoot==="function"){
        const near = getNearbyLoot();
        if(near && typeof openLootChoice==="function"){
          openLootChoice(near);
        }
      }
    }catch(_){}
  }
  btn.addEventListener("click", (e)=>{ stop(e); tryLoot(); });
  btn.addEventListener("touchstart", (e)=>{ stop(e); tryLoot(); }, {passive:false});
})();

/* ===== Loot input 분리: 화면터치 루팅 차단 + 버튼(건틀릿)만 허용 ===== */
(function(){
  if(window.__lootIsolationV1) return;
  window.__lootIsolationV1 = true;

  // 1) openLootChoice를 "버튼에서만" 열리도록 게이트
  if(typeof window.openLootChoice === "function" && !window.__openLootChoiceWrapped){
    const __origOpenLootChoice = window.openLootChoice;
    window.openLootChoice = function(near){
      if(window.__lootFromBtn === true){
        return __origOpenLootChoice(near);
      }
      // 화면 터치/기타 입력에서 호출된 루팅은 무시
      return;
    };
    window.__openLootChoiceWrapped = true;
  }

  // 2) 독립 루팅 함수: 버튼이 이 함수만 호출
  window.lootNearbyItems = function(){
    try{
      window.__lootFromBtn = true;
      // 같은 tick 끝나면 해제
      setTimeout(()=>{ window.__lootFromBtn = false; }, 0);

      const near = (typeof window.getNearbyLoot === "function") ? window.getNearbyLoot() : null;
      if(near && typeof window.openLootChoice === "function"){
        window.openLootChoice(near);
      }
    }catch(_){}
  };

  // 3) 건틀릿 버튼: 기존 리스너 제거(클론) 후 새 리스너 부착
  const oldBtn = UI.el("lootBtn");
  if(oldBtn && oldBtn.parentNode){
    const btn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(btn, oldBtn);

    function stop(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} }
    btn.addEventListener("click", (e)=>{ stop(e); window.lootNearbyItems(); });
    btn.addEventListener("touchstart", (e)=>{ stop(e); window.lootNearbyItems(); }, {passive:false});
  }
})();


/* ===== Loot button positioning + action (버튼만 루팅) ===== */
(function(){
  if(window.__lootAboveUV1) return;
  window.__lootAboveUV1 = true;

  const btn = UI.el("lootBtn");
  if(!btn) return;

  function stop(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} }

  function tryLoot(){
    try{
      // 버튼에서만 루팅 UI 허용
      window.__lootFromBtn = true;
      setTimeout(()=>{ window.__lootFromBtn = false; }, 0);

      const near = (typeof window.getNearbyLoot==="function") ? window.getNearbyLoot() : null;
      if(near && typeof window.openLootChoice==="function"){
        window.openLootChoice(near);
      }
    }catch(_){}
  }

  btn.addEventListener("click", (e)=>{ stop(e); tryLoot(); });
  btn.addEventListener("touchstart", (e)=>{ stop(e); tryLoot(); }, {passive:false});

  // 위치 업데이트: drawOrbUI가 매 프레임 orbUIState.cx/cy를 넣어줌
  function pos(){
    try{
      const st = (typeof orbUIState!=='undefined') ? orbUIState : null;
      if(st && typeof st.cx==="number" && typeof st.cy==="number"){
        const size = 64;
        const offsetY = 20; // U 위로
        btn.style.right = "auto"; btn.style.bottom = "auto";
        btn.style.left = (st.cx - size/2) + "px";
        btn.style.top  = (st.cy - offsetY - size/2) + "px";
      }
    }catch(_){}
    requestAnimationFrame(pos);
  }
  requestAnimationFrame(pos);
})();


/* ===== Loot gate: openLootChoice는 버튼에서만 ===== */
(function(){
  if(window.__lootGateV2) return;
  window.__lootGateV2 = true;
  if(typeof window.openLootChoice === "function" && !window.__openLootChoiceWrapped){
    const _o = window.openLootChoice;
    window.openLootChoice = function(near){
      if(window.__lootFromBtn === true) return _o(near);
      return;
    };
    window.__openLootChoiceWrapped = true;
  }
})();


/* ===== LootBtn position: U 바로 위 ===== */
(function(){
  if(window.__lootPosV1) return;
  window.__lootPosV1 = true;
  const btn = UI.el("lootBtn");
  if(!btn) return;

  function place(){
    try{
      if(typeof orbUIState !== "undefined" && orbUIState && typeof orbUIState.cx==="number"){
        const size = 56;
        const offsetY = 20; // U 위로 (더 아래로)
        btn.style.left = (orbUIState.cx - size/2) + "px";
        btn.style.top  = (orbUIState.cy - offsetY - size/2) + "px";
        btn.style.right = "auto";
        btn.style.bottom = "auto";
      }
    }catch(_){}
    requestAnimationFrame(place);
  }
  requestAnimationFrame(place);
})();


/* ===== Loot button handler: 버튼만 루팅 ===== */
(function(){
  if(window.__lootBtnHandlerV3) return;
  window.__lootBtnHandlerV3 = true;
  const btn = UI.el("lootBtn");
  if(!btn) return;

  function stop(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} }

  window.lootNearbyItems = function(){
    try{
      window.__lootFromBtn = true;
      setTimeout(()=>{ window.__lootFromBtn = false; }, 0);
      const near = (typeof getNearbyLoot==="function") ? getNearbyLoot() : null;
      if(near && typeof openLootChoice==="function") openLootChoice(near);
    }catch(_){}
  };

  // remove previous listeners by cloning
  const clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);

  clone.addEventListener("click", (e)=>{ stop(e); window.lootNearbyItems(); });
  clone.addEventListener("touchstart", (e)=>{ stop(e); window.lootNearbyItems(); }, {passive:false});
})();


/* lootToastV24 + loot handler 강화 */
(function(){
  if(window.__lootBtnV24) return;
  window.__lootBtnV24 = true;

  const btn = UI.el("lootBtn");
  const toast = UI.el("lootToast");
  if(!btn) return;

  function stop(e){ try{ e.preventDefault(); e.stopPropagation(); }catch(_){} }

  function show(msg){
    if(!toast) return;
    toast.textContent = msg;
    toast.style.display = "block";
    clearTimeout(window.__lootToastTimer);
    window.__lootToastTimer = setTimeout(()=>{ toast.style.display="none"; }, 700);
  }

  function tryLoot(){
    try{
      const near = (typeof getNearbyLoot==="function") ? getNearbyLoot() : null;
      if(!near){ show("근처 아이템 없음"); return; }

      // 버튼에서만 루팅 UI 허용 (게이트가 있으면 통과)
      window.__lootFromBtn = true;
      setTimeout(()=>{ window.__lootFromBtn = false; }, 0);

      if(typeof openLootChoice==="function"){
        openLootChoice(near);
        show("루팅");
      }else{
        show("루팅 함수 없음");
      }
    }catch(err){
      show("루팅 에러");
      // console.log(err);
    }
  }

  // remove previous listeners safely by cloning
  const clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);

  clone.addEventListener("click", (e)=>{ stop(e); tryLoot(); });
  clone.addEventListener("touchend", (e)=>{ stop(e); tryLoot(); }, {passive:false});
  clone.addEventListener("touchstart", (e)=>{ stop(e); }, {passive:false});
})();



  // ===== lootBtn binding (v2: UI -> Game.pressLoot) =====
  // game.js는 더 이상 DOM에서 lootBtn을 찾거나 바인딩하지 않는다.
  // UI에서 Game.pressLoot()를 호출해준다.

  // ===== v2 Step2 export =====

window.Game = window.Game || {};
// app.js가 canvas를 전달
window.Game.bindCanvas = function(c){
  canvas = c || canvas;
  if(canvas && !ctx) ctx = canvas.getContext("2d");
};

// UI 입력 주입
window.Game.setJoy = setJoy;
window.Game.setAttack = setAttack;
window.Game.pressLoot = pressLoot;

window.Game.init = function(){ try{ if(typeof resetGame==="function") resetGame(); }catch(_){} };
if(typeof resize==="function") window.Game.resize = resize;
if(typeof loop==="function") window.Game.loop = loop;

/* __GAME_V2_GUARD_END__ */
}

/* ===== v2 Patch: Disable legacy panel system (User chose option 1) =====
   Goal: game.js must NOT hide HUD or manage overlays/panels. UI owns overlays. */
(function(){
  try{
    // Neutralize legacy overlay counters / body class toggles if they exist
    if (typeof overlayPush === "function") {
      window.__legacy_overlayPush = overlayPush;
      window.overlayPush = function(){
        // delegate to UI overlay stack when possible
        try{ window.UIOverlay && window.UIOverlay.push && window.UIOverlay.push("craftOverlay"); }catch(_){}
      };
    }
    if (typeof overlayPop === "function") {
      window.__legacy_overlayPop = overlayPop;
      window.overlayPop = function(){
        try{ window.UIOverlay && window.UIOverlay.pop && window.UIOverlay.pop("craftOverlay"); }catch(_){}
      };
    }

    // If legacy closePanels/openPanel exist, make them safe no-ops (do NOT touch HUD/body classes)
    if (typeof closePanels === "function") {
      window.__legacy_closePanels = closePanels;
      window.closePanels = function(){
        // just ensure body classes cleared; UI handles actual overlay hiding
        try{
          document.body.classList.remove("overlayActive","panel-open");
          const hud = document.getElementById("ui");
          if(hud) hud.style.display = "flex";
        }catch(_){}
      };
    }
    if (typeof openPanel === "function") {
      window.__legacy_openPanel = openPanel;
      window.openPanel = function(){ /* disabled */ };
    }

    // Some builds use setOverlayActive(true/false)
    if (typeof setOverlayActive === "function") {
      window.__legacy_setOverlayActive = setOverlayActive;
      window.setOverlayActive = function(on){
        try{
          if(!on) document.body.classList.remove("overlayActive","panel-open");
          else document.body.classList.add("overlayActive");
        }catch(_){}
      };
    }

    // Expose minimal API for UI to pause/unpause if it wants
    window.Game = window.Game || {};
    if (!window.Game.setPaused) {
      window.Game.setPaused = function(on){
        try{
          if (typeof gamePaused !== "undefined") gamePaused = !!on;
        }catch(_){}
      };
    }
  }catch(_){}
})();


/* ===== v2 FINAL: UI owns overlays; disable legacy panel/hud hiding ===== */
(function(){
  try{
    // Always allow HUD
    function restoreHUD(){
      try{
        const hud = document.getElementById("ui");
        if(hud) hud.style.display = "flex";
        document.body.classList.remove("overlayActive","panel-open");
      }catch(_){}
    }

    // If legacy functions exist, override them to be safe.
    if (typeof overlayPush === "function") {
      window.__legacy_overlayPush = overlayPush;
      window.overlayPush = function(){ try{ document.body.classList.add("overlayActive"); }catch(_){} };
    }
    if (typeof overlayPop === "function") {
      window.__legacy_overlayPop = overlayPop;
      window.overlayPop = function(){ restoreHUD(); };
    }
    if (typeof closePanels === "function") {
      window.__legacy_closePanels = closePanels;
      window.closePanels = function(){ restoreHUD(); };
    }
    if (typeof openPanel === "function") {
      window.__legacy_openPanel = openPanel;
      window.openPanel = function(){ /* disabled in FINAL */ };
    }

    // Export safe close for UI
    window.Game = window.Game || {};
    if(!window.Game.closePanels){
      window.Game.closePanels = function(){ restoreHUD(); };
    }

    
  }catch(_){}}
  // ===== V2 Game Interface (필수) =====
window.Game = {
  bindCanvas(c){
    canvas = c;
    if(canvas){
      ctx = canvas.getContext("2d");
    }
  },

 resize(w,h,uiH){
  if (typeof window.resize === "function") {
    window.resize(w,h,uiH);
  }
},

  init(){
    // 초기화 필요하면 여기
  },

  loop(){
    if(!ctx) return;
    update();
    draw();
  }
};
})();
