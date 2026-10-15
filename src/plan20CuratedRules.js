// Manually curated Plan20 candidates. scripts/mine-settled-segments.mjs must not overwrite this file.
// Segment definition mirrors reports/plan20-segments.json shortlist {"price":".20-.35","hour":"12-16"}:
// all source plans, all directions, all markets; price band [0.20,0.35); 4h UTC entry bucket 12:00-15:59.
export const PLAN20_CURATED_RULES = Object.freeze([
  {
    id: 'price_20_35_hour_12_16_utc',
    match: Object.freeze({ price: '.20-.35', hour: '12-16' }),
    status: 'candidate',
    note: 'candidate, holdout n=26, ROI +52%, not validated',
    stakeUsd: 2,
    train: Object.freeze({ n: 54, roi: 0.7393 }),
    holdout: Object.freeze({ n: 26, roi: 0.52 })
  }
].map((rule) => Object.freeze(rule)));
