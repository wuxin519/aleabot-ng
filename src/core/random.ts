/**
 * 随机源：可注入的随机数发生器，便于测试时使用确定性序列。
 * 默认使用 Math.random，生产环境足够（骰子场景非加密用途）。
 */
export type RandomFn = () => number;

/** 默认随机源 */
export const defaultRandom: RandomFn = () => Math.random();

/**
 * 抛掷单个骰子，返回 1..sides 的整数。
 * @param sides 骰面数（如 6 表示 d6）
 * @param rng 随机源
 */
export function rollDie(sides: number, rng: RandomFn = defaultRandom): number {
  if (!Number.isInteger(sides) || sides < 2) {
    throw new Error(`无效的骰面数: ${sides}`);
  }
  return Math.floor(rng() * sides) + 1;
}

/** 批量抛掷 n 个 s 面骰 */
export function rollDice(count: number, sides: number, rng: RandomFn = defaultRandom): number[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`无效的骰子数量: ${count}`);
  }
  if (count > 1000) {
    // 防止恶意/误输入导致资源耗尽
    throw new Error(`骰子数量过大: ${count}（上限 1000）`);
  }
  const out: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = rollDie(sides, rng);
  }
  return out;
}

/** 使用固定种子的伪随机源（xorshift32），用于测试与可复现结果 */
export function seededRandom(seed: number): RandomFn {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
