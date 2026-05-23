# RunwayOS One-Pager

## Problem
Portfolio companies and startups commonly overpay for orphaned SaaS seats after employee departures. The leakage is distributed, recurring, and hard to track across systems.

## Solution
RunwayOS links HR offboarding events to SaaS seat discovery, controlled deactivation workflow, and finance-grade runway impact reporting.

## How It Works
1. Offboarding webhook received
2. Seats flagged and moved to `PENDING_REMOVAL`
3. Projection engine freeze prevents premature assumptions
4. Admin/API confirmation moves assets to `DEACTIVATED`
5. Realized savings applied to runway model
6. CSV artifact exported for finance records

## Security Highlights
- Timing-safe signature checks
- Replay-window enforcement
- Raw payload signature verification path
- Tenant-scoped data boundaries

## Ideal Users
- Fractional CFO firms
- VC operating partners
- Startup finance/ops leaders

## Primary Outcomes
- Reduced SaaS spend leakage
- Cleaner financial projections
- Faster offboarding controls with audit trail
