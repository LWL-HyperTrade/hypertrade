/**
 * AiReasoningModal — "why did the AI do this?" viewer for one symbol.
 *
 * Opened from the Reasoning button on bot-badged positions in PortfolioTabs.
 * Two sections, per product design:
 *   1. Opening reasoning (collapsible) — why the agent went LONG/SHORT in the
 *      first place: latest opening decision for the symbol.
 *   2. Recent check-ins — monitor decisions for THIS open position only
 *      (scoped by openedAt), newest first, 3 at a time with "load more".
 *
 * Matches the app's modal branding (dark card, gold accents).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { colors } from '../theme/colors';
import { useAuth } from '../providers/AuthContext';
import { fetchAiAgentDecisionsPage, type AiAgentDecision } from '../lib/api';
import { useNextCycleCountdown } from '../lib/aiAgentHourlyCycle';
import { formatDisplaySymbol } from '../lib/displaySymbols';
import i18n from '../i18n';

const PAGE_SIZE = 3;
const COPY_FEEDBACK_MS = 1600;

/**
 * Tap the reasoning body (or the copy icon) to copy — green check, no toast.
 * For non-native speakers who want to paste into a translator quickly.
 */
export function CopyableDecisionText({
  text,
  style,
  containerStyle,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const value = text.trim();
    if (!value) return;
    await Clipboard.setStringAsync(value);
    if (Platform.OS !== 'web') {
      void Haptics.selectionAsync().catch(() => {});
    }
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  }, [text]);

  return (
    <TouchableOpacity
      onPress={() => void handleCopy()}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel="Copy"
      style={[styles.copyableRow, containerStyle]}
    >
      <Text style={[style, styles.copyableText]}>{text}</Text>
      <Ionicons
        name={copied ? 'checkmark' : 'copy-outline'}
        size={14}
        color={copied ? colors.status.success : colors.text.tertiary}
        style={styles.copyableIcon}
      />
    </TouchableOpacity>
  );
}

interface Props {
  visible: boolean;
  agentId: string;
  agentName: string;
  symbol: string;
  /** Live open side (updates after flips). Prefer over opening-decision direction in the title. */
  direction?: 'LONG' | 'SHORT' | null;
  /** When set, only show decisions from this position lifecycle (openedAt). */
  since?: string | null;
  onClose: () => void;
}

/** Min-size / dust talk that should not lead the feed — thesis stays in `reason`. */
const SIZE_MECHANICS =
  /too small to (?:trim|leave|keep|partially)|order will become too small|(?:leftover|remainder|stub).{0,48}(?:too small|dust|below)|below the min(?:imum)?(?: order)? size|min(?:imum)? order size|dust[- ]sized leftover|would leave (?:a )?(?:dust|stub|leftover)|can(?:not|'t) trim (?:it )?(?:without|because)|position (?:is|will be|would be|would become) too small|trim would (?:have )?(?:left|leave|escalate)|flattened instead of kept|young (?:position )?and a trim|wanted to trim but|closed the full position because/i;

function stripSizeMechanicsFromSummary(text: string): string {
  const body = text.replace(/^summary\s*:\s*/i, '').trim();
  if (!body) return '';
  const sentences = body.match(/[^.!?]+[.!?]*\s*/g) ?? [body];
  const kept = sentences.filter((s) => s.trim() && !SIZE_MECHANICS.test(s));
  return kept.join(' ').trim();
}

/** Ensure the plain-English intro is labeled so users know it's a summary. */
function withSummaryLabel(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return /^summary\s*:/i.test(t)
    ? `Summary: ${t.replace(/^summary\s*:\s*/i, '')}`
    : `Summary: ${t}`;
}

/** Pull reasoning text from decision jsonb, or from the stored LLM response blob. */
function extractReasoningBody(
  dec: Record<string, any>,
  reasoning: unknown,
): string | null {
  // Plain-English summary (newer rows) leads; the metric-citing reason
  // follows as its own paragraph so technical readers lose nothing.
  // Prefer llmSummary when the worker used to overwrite summary with dust copy.
  const summaryCandidate =
    (typeof dec.decisionBody?.llmSummary === 'string' &&
      dec.decisionBody.llmSummary.trim()) ||
    (typeof dec.summary === 'string' && dec.summary.trim()) ||
    (typeof dec.decisionBody?.summary === 'string' &&
      dec.decisionBody.summary.trim()) ||
    null;
  const thesisSummary = summaryCandidate
    ? stripSizeMechanicsFromSummary(summaryCandidate)
    : '';
  const summary = thesisSummary ? withSummaryLabel(thesisSummary) : null;
  const fromDec =
    (typeof dec.reasoning === 'string' && dec.reasoning.trim()) ||
    (typeof dec.decisionBody?.reason === 'string' && dec.decisionBody.reason.trim()) ||
    (typeof dec.decisionBody?.reasoning === 'string' && dec.decisionBody.reasoning.trim()) ||
    null;
  if (summary) return fromDec && fromDec !== thesisSummary ? `${summary}\n\n${fromDec}` : summary;
  if (fromDec) return fromDec;

  const blob = reasoning as Record<string, any> | null;
  const raw = blob?.response;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const sRaw = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const sBody = sRaw ? stripSizeMechanicsFromSummary(sRaw) : '';
    const s = sBody ? withSummaryLabel(sBody) : '';
    const r =
      (typeof parsed.reasoning === 'string' && parsed.reasoning.trim()) ||
      (typeof parsed.reason === 'string' && parsed.reason.trim()) ||
      '';
    if (s && r) return `${s}\n\n${r}`;
    if (s || r) return s || r;
  } catch {
    // Non-JSON model reply — show a short slice so invalid rows aren't blank.
  }
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
}

/** Pull a human-readable summary out of a decision row's jsonb. */
export function decisionDirection(d: AiAgentDecision): 'LONG' | 'SHORT' | null {
  const dec = (d.decision ?? {}) as Record<string, any>;
  // Prefer explicit position side. Do NOT use flipSide — that's the opposite
  // suggestion on losing monitors, not the held side.
  const raw =
    dec.direction ??
    (typeof dec.decision === 'string' &&
    (dec.decision === 'LONG' || dec.decision === 'SHORT' ||
      dec.decision === 'long' || dec.decision === 'short')
      ? dec.decision
      : null) ??
    null;
  const s = String(raw ?? '').toUpperCase();
  if (s === 'LONG' || s === 'SHORT') return s;
  return null;
}

const MONITOR_ACTION_I18N: Record<string, string> = {
  HOLD: 'aiAgents.decisionActionHold',
  TRIM: 'aiAgents.decisionActionTrim',
  ADD: 'aiAgents.decisionActionAdd',
  DCA: 'aiAgents.decisionActionDca',
  EXIT: 'aiAgents.decisionActionExit',
  FLIP: 'aiAgents.decisionActionFlip',
  CUT: 'aiAgents.decisionActionCut',
};

function monitorActionLabel(action: string): string {
  const key = MONITOR_ACTION_I18N[action];
  return key ? String(i18n.t(key)) : action;
}

export function decisionSummary(d: AiAgentDecision): {
  headline: string;
  body: string | null;
  tone: 'positive' | 'negative' | 'neutral';
  direction: 'LONG' | 'SHORT' | null;
  /** Opening conviction 0–100 when present; shown on its own labeled line. */
  conviction: number | null;
  /**
   * Monitor ROE % (price move × leverage) at check time — not conviction.
   * Rendered separately in green/red; openings leave this null.
   */
  pnlPct: number | null;
} {
  const dec = (d.decision ?? {}) as Record<string, any>;
  const type = d.type;
  const body = extractReasoningBody(dec, d.reasoning);
  // Prefer explicit position side from the decision payload. For older HOLD
  // rows that omitted it, callers may pass a live open-position fallback.
  const direction = decisionDirection(d);

  if (type.startsWith('opening')) {
    if (type === 'opening_invalid') {
      const err =
        typeof dec.error === 'string'
          ? dec.error
          : String(i18n.t('aiAgents.decisionInvalidModelOutput'));
      // Prefer direction from the LLM reply when decision only has { error }.
      let dirLabel: string | null = direction;
      let conviction: number | null =
        typeof dec.conviction === 'number' ? dec.conviction : null;
      const raw = (d.reasoning as Record<string, any> | null)?.response;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as Record<string, any>;
          if (!dirLabel && typeof parsed.decision === 'string') {
            const p = String(parsed.decision).toUpperCase();
            if (p === 'LONG' || p === 'SHORT') dirLabel = p;
          }
          if (conviction == null && typeof parsed.conviction === 'number') {
            conviction = parsed.conviction;
          }
        } catch {
          // ignore
        }
      }
      const dir = dirLabel ?? String(i18n.t('aiAgents.decisionModelReply'));
      return {
        headline: String(
          i18n.t('aiAgents.decisionInvalidOpen', { dir, error: err }),
        ),
        body,
        tone: 'negative',
        direction: dirLabel === 'LONG' || dirLabel === 'SHORT' ? dirLabel : null,
        conviction,
        pnlPct: null,
      };
    }
    const conviction =
      typeof dec.conviction === 'number' && Number.isFinite(dec.conviction)
        ? dec.conviction
        : null;
    if (type === 'opening_flat') {
      return {
        headline: String(i18n.t('aiAgents.decisionFlat')),
        body,
        tone: 'neutral',
        direction,
        conviction,
        pnlPct: null,
      };
    }
    // Direction is shown next to the symbol in lists; keep headline action-focused.
    return {
      headline: String(
        i18n.t(
          type.endsWith('dry_run')
            ? 'aiAgents.decisionShadowOpen'
            : 'aiAgents.decisionOpened',
        ),
      ),
      body,
      tone: 'positive',
      direction,
      conviction,
      pnlPct: null,
    };
  }
  if (type.startsWith('monitor')) {
    const escalated = !!dec.decisionBody?.trimEscalatedToClose && dec.executed;
    const marginDust = !!dec.decisionBody?.marginDust;
    const action = String(escalated ? 'cut' : (dec.action ?? 'hold')).toUpperCase();
    // Prefer ROE (matches PortfolioTabs). Fall back to legacy price-% rows.
    const pnlNum = Number(
      Number.isFinite(Number(dec.roePct)) ? dec.roePct : dec.pnlPct,
    );
    const hasPnl = Number.isFinite(pnlNum);
    const fromDir = String(dec.fromDirection ?? dec.decisionBody?.fromDirection ?? '').toUpperCase();
    const toDir = String(dec.toDirection ?? dec.decisionBody?.toDirection ?? '').toUpperCase();
    const flipArrow =
      action === 'FLIP' && (fromDir === 'LONG' || fromDir === 'SHORT') && (toDir === 'LONG' || toDir === 'SHORT')
        ? ` ${fromDir}→${toDir}`
        : '';
    const flipPartial = !!dec.decisionBody?.flipPartial && dec.executed;
    const tone: 'positive' | 'negative' | 'neutral' = hasPnl
      ? pnlNum > 0
        ? 'positive'
        : pnlNum < 0
          ? 'negative'
          : 'neutral'
      : ['EXIT', 'CUT'].includes(action)
        ? 'negative'
        : action === 'HOLD'
          ? 'neutral'
          : 'positive';
    const suffix = escalated
      ? String(
          i18n.t(
            marginDust
              ? 'aiAgents.decisionTrimEscalatedMarginDust'
              : 'aiAgents.decisionTrimEscalated',
          ),
        )
      : flipPartial
        ? String(i18n.t('aiAgents.decisionFlipPartial'))
        : type.endsWith('dry_run')
          ? String(i18n.t('aiAgents.decisionShadowSuffix'))
          : '';
    // Monitors do not emit a fresh conviction — prompts only cite the opening
    // one. A line appears only if a rare payload still carries the field.
    const conviction =
      typeof dec.conviction === 'number' && Number.isFinite(dec.conviction)
        ? dec.conviction
        : typeof dec.decisionBody?.conviction === 'number' &&
            Number.isFinite(dec.decisionBody.conviction)
          ? dec.decisionBody.conviction
          : null;

    // Action/headline already shows CUT vs TRIM. Keep the thesis summary as
    // the body — do not lead with min-size / dust mechanics.
    return {
      headline: `${monitorActionLabel(action)}${flipArrow}${suffix}`,
      body,
      tone,
      direction: toDir === 'LONG' || toDir === 'SHORT' ? toDir : direction,
      conviction,
      pnlPct: hasPnl ? pnlNum : null,
    };
  }
  if (type === 'skipped_user_conflict') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedUserConflict')),
      body: null,
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  if (type === 'skipped_peer_symbol') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedPeer')),
      body: null,
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  if (type === 'skipped_budget') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedBudget')),
      body: null,
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  // Live L2 gate: the book could not absorb the planned size cleanly.
  if (type === 'skipped_thin_book') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedThinBook')),
      body: String(i18n.t('aiAgents.decisionSkippedThinBookBody')),
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  if (type === 'skipped_stopped') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedStopped')),
      body: String(i18n.t('aiAgents.decisionSkippedStoppedBody')),
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  if (type === 'skipped_paused') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedPaused')),
      body: String(i18n.t('aiAgents.decisionSkippedPausedBody')),
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  if (type === 'skipped_no_data' || type === 'skipped_no_price') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedNoData')),
      body: typeof dec.reason === 'string' ? dec.reason : null,
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  // Swing/investor: FLAT already logged for this opening window — not a data gap.
  if (type === 'skipped_no_new_bar') {
    return {
      headline: String(i18n.t('aiAgents.decisionSkippedAwaitingWindow')),
      body: String(i18n.t('aiAgents.decisionSkippedAwaitingWindowBody')),
      tone: 'neutral',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  if (type === 'reconciled_closed') {
    const closeReason = String(dec.closeReason ?? '').toLowerCase();
    let closedBody = String(i18n.t('aiAgents.decisionClosedBody'));
    if (closeReason === 'stop_fill' || closeReason === 'stop' || closeReason === 'sl_fill') {
      closedBody = String(i18n.t('aiAgents.decisionClosedByStop'));
    } else if (closeReason === 'tp_fill' || closeReason === 'take_profit' || closeReason === 'tp') {
      closedBody = String(i18n.t('aiAgents.decisionClosedByTp'));
    } else if (closeReason === 'liquidation' || closeReason === 'liquidated' || dec.liquidated === true) {
      closedBody = String(i18n.t('aiAgents.decisionClosedByLiq'));
    } else if (closeReason === 'manual' || closeReason === 'user') {
      closedBody = String(i18n.t('aiAgents.decisionClosedManual'));
    }
    const prev = typeof dec.previous === 'string' ? dec.previous.toUpperCase() : null;
    return {
      // Short headline — sits on one line with symbol · side · date.
      headline: String(i18n.t('aiAgents.decisionClosed')),
      body: closedBody,
      tone: closeReason === 'liquidation' || closeReason === 'liquidated' || dec.liquidated === true
        ? 'negative'
        : 'neutral',
      direction: prev === 'LONG' || prev === 'SHORT' ? prev : direction,
      conviction: null,
      pnlPct: null,
    };
  }
  if (type === 'error') {
    const msg = typeof dec.message === 'string' ? dec.message : type.replace(/_/g, ' ');
    return {
      headline: msg,
      body,
      tone: 'negative',
      direction,
      conviction: null,
      pnlPct: null,
    };
  }
  return {
    headline: type.replace(/_/g, ' '),
    body,
    tone: 'neutral',
    direction,
    conviction: null,
    pnlPct: null,
  };
}

export function toneColor(tone: 'positive' | 'negative' | 'neutral'): string {
  if (tone === 'positive') return colors.status.success;
  if (tone === 'negative') return colors.status.error;
  return colors.text.secondary;
}

/** Action labels (Opened / Hold / Trim / …) — brand purple; PnL % uses toneColor separately. */
export const DECISION_ACTION_COLOR = colors.text.primary;

/** Format monitor ROE for the decision headline (sign + 2dp). */
export function formatDecisionPnlPct(pnlPct: number): string {
  return `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
}

export function directionColor(dir: 'LONG' | 'SHORT' | null | undefined): string {
  if (dir === 'LONG') return colors.status.success;
  if (dir === 'SHORT') return colors.status.error;
  return colors.text.secondary;
}

/** Flat stays quiet grey; true failures red; all other actions gold yellow. */
export function decisionActionColor(tone: 'positive' | 'negative' | 'neutral', type: string): string {
  if (type === 'opening_flat' || type.endsWith('_flat')) {
    return colors.text.secondary;
  }
  if (
    tone === 'negative' &&
    (type.includes('invalid') ||
      type.includes('rejected') ||
      type.includes('error') ||
      type === 'reconciled_closed')
  ) {
    return colors.status.error;
  }
  return DECISION_ACTION_COLOR;
}

export function AiReasoningModal({
  visible,
  agentId,
  agentName,
  symbol,
  direction: liveDirection = null,
  since = null,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const { getAccessToken } = useAuth();
  const nextCycleCountdown = useNextCycleCountdown();

  const [opening, setOpening] = useState<AiAgentDecision | null>(null);
  const [openingExpanded, setOpeningExpanded] = useState(false);
  const [checks, setChecks] = useState<AiAgentDecision[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadInitial = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    setLoading(true);
    try {
      const sinceArg = since?.trim() ? { since: since.trim() } : {};
      const [openingPage, monitorPage] = await Promise.all([
        fetchAiAgentDecisionsPage(
          { agentId, symbol, kind: 'opening', limit: 1, ...sinceArg },
          token,
        ),
        fetchAiAgentDecisionsPage(
          { agentId, symbol, kind: 'monitor', limit: PAGE_SIZE, ...sinceArg },
          token,
        ),
      ]);
      setOpening(openingPage.decisions[0] ?? null);
      setChecks(monitorPage.decisions);
      setOffset(monitorPage.decisions.length);
      setHasMore(monitorPage.hasMore);
    } catch {
      // Surface as empty state; the modal shows "no decisions yet".
    } finally {
      setLoading(false);
    }
  }, [agentId, symbol, since, getAccessToken]);

  const loadMore = useCallback(async () => {
    const token = await getAccessToken();
    if (!token || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchAiAgentDecisionsPage(
        {
          agentId,
          symbol,
          kind: 'monitor',
          offset,
          limit: PAGE_SIZE,
          ...(since?.trim() ? { since: since.trim() } : {}),
        },
        token,
      );
      setChecks((prev) => [...prev, ...page.decisions]);
      setOffset(offset + page.decisions.length);
      setHasMore(page.hasMore);
    } catch {
      // keep existing page
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, symbol, since, offset, loadingMore, getAccessToken]);

  useEffect(() => {
    if (!visible) return;
    setOpening(null);
    setChecks([]);
    setOffset(0);
    setHasMore(false);
    setOpeningExpanded(false);
    void loadInitial();
  }, [visible, loadInitial]);

  const openingSummary = opening ? decisionSummary(opening) : null;
  // Title side = live book (post-flip). Opening section still explains the original entry.
  const titleDirection = liveDirection ?? openingSummary?.direction ?? null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>
                {t('aiAgents.reasoningTitle')} · {formatDisplaySymbol(symbol)}
                {titleDirection ? (
                  <>
                    {' · '}
                    <Text style={{ color: directionColor(titleDirection) }}>{titleDirection}</Text>
                  </>
                ) : null}
              </Text>
              <Text style={styles.subtitle}>{agentName}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.text.primary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.accent.gold} style={{ marginVertical: 32 }} />
          ) : (
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
              {/* ── Opening reasoning (collapsible) ── */}
              {opening && openingSummary ? (
                <View style={styles.openingBox}>
                  <TouchableOpacity
                    style={styles.openingHeader}
                    onPress={() => setOpeningExpanded((v) => !v)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="flag-outline" size={14} color={colors.accent.gold} />
                    <Text style={styles.openingTitle}>
                      {t('aiAgents.openingReasoning')}
                    </Text>
                    <Text style={styles.timestamp}>
                      {new Date(opening.created_at).toLocaleString()}
                    </Text>
                    <Ionicons
                      name={openingExpanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={colors.text.tertiary}
                    />
                  </TouchableOpacity>
                  {openingExpanded ? (
                    <>
                      <Text style={[styles.openingHeadline, { marginTop: 8, textAlign: 'left' }]}>
                        {openingSummary.direction ? (
                          <>
                            <Text style={{ color: directionColor(openingSummary.direction) }}>
                              {openingSummary.direction}
                            </Text>
                            <Text style={{ color: colors.text.secondary }}> · </Text>
                          </>
                        ) : null}
                        <Text
                          style={{
                            color: decisionActionColor(openingSummary.tone, opening.type),
                          }}
                        >
                          {openingSummary.headline}
                        </Text>
                      </Text>
                      {openingSummary.conviction != null ? (
                        <Text style={[styles.convictionLine, { marginTop: 8 }]}>
                          <Text style={styles.convictionLabel}>
                            {t('aiAgents.conviction')}:{' '}
                          </Text>
                          <Text style={styles.convictionValue}>
                            {openingSummary.conviction}/100
                          </Text>
                        </Text>
                      ) : null}
                      {openingSummary.body ? (
                        <CopyableDecisionText
                          text={openingSummary.body}
                          style={styles.openingBody}
                          containerStyle={{ marginTop: 8 }}
                        />
                      ) : (
                        <Text style={styles.emptyText}>
                          {t('aiAgents.noReasoningText')}
                        </Text>
                      )}
                    </>
                  ) : null}
                </View>
              ) : null}

              {/* ── Hourly monitoring decisions, newest first ── */}
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{t('aiAgents.recentChecks')}</Text>
                <View style={styles.sectionCountdown}>
                  <Ionicons name="time-outline" size={12} color={colors.accent.gold} />
                  <Text style={styles.sectionCountdownText} numberOfLines={1}>
                    {t('aiAgents.nextDecisionIn', { time: nextCycleCountdown })}
                  </Text>
                </View>
              </View>
              {checks.length === 0 ? (
                <Text style={styles.emptyText}>
                  {t('aiAgents.noChecksYet')}
                </Text>
              ) : (
                checks.map((d) => {
                  const s = decisionSummary(d);
                  const dir = s.direction ?? openingSummary?.direction ?? null;
                  const createdAt = new Date(d.created_at);
                  return (
                    <View key={d.id} style={styles.checkRow}>
                      <View style={styles.checkHeader}>
                        <Text style={styles.checkHeadline} numberOfLines={1}>
                          {dir ? (
                            <>
                              <Text style={{ color: directionColor(dir) }}>{dir}</Text>
                              <Text style={{ color: colors.text.secondary }}> · </Text>
                            </>
                          ) : null}
                          <Text style={{ color: decisionActionColor(s.tone, d.type) }}>
                            {s.headline}
                          </Text>
                        </Text>
                        <View style={styles.timestampCol}>
                          <Text style={styles.timestamp}>
                            {createdAt.toLocaleDateString()}
                          </Text>
                          <Text style={styles.timestamp}>
                            {createdAt.toLocaleTimeString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </Text>
                        </View>
                      </View>
                      {s.conviction != null ? (
                        <Text style={[styles.convictionLine, { marginTop: 6 }]}>
                          <Text style={styles.convictionLabel}>
                            {t('aiAgents.conviction')}:{' '}
                          </Text>
                          <Text style={styles.convictionValue}>
                            {s.conviction}/100
                          </Text>
                        </Text>
                      ) : null}
                      {s.pnlPct != null ? (
                        <Text style={[styles.convictionLine, { marginTop: s.conviction != null ? 2 : 6 }]}>
                          <Text style={styles.convictionLabel}>
                              {t('aiAgents.pnlAtCheck')}:{' '}
                          </Text>
                          <Text style={[styles.convictionValue, { color: toneColor(s.tone) }]}>
                            {formatDecisionPnlPct(s.pnlPct)}
                          </Text>
                        </Text>
                      ) : null}
                      {s.body ? (
                        <CopyableDecisionText
                          text={s.body}
                          style={styles.checkBody}
                          containerStyle={{ marginTop: 4 }}
                        />
                      ) : null}
                    </View>
                  );
                })
              )}

              {hasMore ? (
                <TouchableOpacity style={styles.loadMore} onPress={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? (
                    <ActivityIndicator size="small" color={colors.accent.gold} />
                  ) : (
                    <Text style={styles.loadMoreText}>{t('aiAgents.loadMore')}</Text>
                  )}
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: colors.background.primary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 16,
    maxHeight: '80%',
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 },
  title: { color: colors.text.primary, fontSize: 15, fontWeight: '900' },
  subtitle: { color: colors.text.tertiary, fontSize: 11, marginTop: 2 },
  scroll: { flexGrow: 0 },
  openingBox: {
    backgroundColor: colors.background.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border.primary,
    padding: 10,
    marginBottom: 12,
  },
  openingHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  openingTitle: { flex: 1, color: colors.text.primary, fontSize: 12, fontWeight: '800' },
  openingHeadline: { fontSize: 11, fontWeight: '700' },
  openingBody: { color: colors.text.secondary, fontSize: 12, lineHeight: 18 },
  convictionLine: { flex: 1, fontSize: 11, lineHeight: 15 },
  convictionLabel: { color: colors.text.tertiary, fontWeight: '600' },
  convictionValue: { color: colors.text.primary, fontWeight: '700' },
  copyableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  copyableText: { flex: 1 },
  copyableIcon: { marginTop: 2 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  sectionTitle: { color: colors.text.primary, fontSize: 12, fontWeight: '800', flexShrink: 0 },
  sectionCountdown: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  sectionCountdownText: { color: colors.accent.gold, fontSize: 10, fontWeight: '700' },
  checkRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border.primary,
    paddingVertical: 8,
  },
  checkHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  checkHeadline: { fontSize: 12, fontWeight: '800', flex: 1 },
  checkBody: { color: colors.text.secondary, fontSize: 11, lineHeight: 16 },
  timestampCol: { alignItems: 'flex-end', flexShrink: 0, gap: 1 },
  timestamp: { color: colors.text.muted, fontSize: 10, lineHeight: 13 },
  emptyText: { color: colors.text.tertiary, fontSize: 12, lineHeight: 17, marginVertical: 6 },
  loadMore: {
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.background.tertiary,
    borderWidth: 1,
    borderColor: colors.border.primary,
  },
  loadMoreText: { color: colors.accent.gold, fontSize: 12, fontWeight: '800' },
});
