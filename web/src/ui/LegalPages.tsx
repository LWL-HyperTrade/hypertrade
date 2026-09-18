import { useTenantBrand } from '../lib/useTenantBrand';

const SUPPORT_EMAIL = 'support@hypertrade.exchange';
const PRIVY_EXPORT_URL = 'https://home.privy.io';
const PLATFORM = 'BuilderPad';
const LAST_UPDATED = 'September 9, 2026';

type Section = { heading: string; lines: string[] };

function SectionBlock({ heading, lines }: Section) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-extrabold">{heading}</h2>
      {lines.map((line) => (
        <p key={line.slice(0, 64)} className="mt-2 text-sm leading-relaxed text-fg-muted">
          {line.includes(PRIVY_EXPORT_URL) ? (
            <>
              {line.split(PRIVY_EXPORT_URL)[0]}
              <a
                href={PRIVY_EXPORT_URL}
                target="_blank"
                rel="noreferrer"
                className="font-bold text-brand hover:underline"
              >
                {PRIVY_EXPORT_URL}
              </a>
              {line.split(PRIVY_EXPORT_URL).slice(1).join(PRIVY_EXPORT_URL)}
            </>
          ) : (
            line
          )}
        </p>
      ))}
    </section>
  );
}

function LegalArticle({ title, subtitle, sections }: { title: string; subtitle: string; sections: Section[] }) {
  return (
    <article className="mx-auto max-w-3xl pb-8">
      <h1 className="display text-3xl sm:text-4xl">{title}</h1>
      <p className="mt-2 text-sm text-fg-subtle">{subtitle}</p>
      {sections.map((s) => (
        <SectionBlock key={s.heading} heading={s.heading} lines={s.lines} />
      ))}
    </article>
  );
}

/**
 * Same document for every creator; only the brand changes. On a creator host
 * `b` is their app name and the intro says it runs on BuilderPad. The operator
 * (LUNATIC WISDOM LABS LLC) never changes.
 */
function termsFor(b: string): Section[] {
  const creator = b !== PLATFORM;
  return [
    {
      heading: '1. Acceptance of Terms',
      lines: [
        `By accessing or using ${b} ("the Interface"), you agree to these Terms of Service and our Privacy Policy. If you do not agree, do not use the Interface.`,
        creator
          ? `${b} is a creator app built on ${PLATFORM}, a software interface operated by LUNATIC WISDOM LABS LLC ("the Company"), a Wyoming limited liability company. The creator configures branding, markets, and fees; the Company operates the software.`
          : `${b} is a software interface operated by LUNATIC WISDOM LABS LLC ("the Company"), a Wyoming limited liability company.`,
      ],
    },
    {
      heading: '1.1 Restricted Jurisdictions & U.S. Persons',
      lines: [
        `${b} strictly prohibits use by "U.S. Persons" (as defined in Regulation S under the U.S. Securities Act of 1933) and residents of Restricted Jurisdictions.`,
        '• Prohibited Jurisdictions: United States, United Kingdom, North Korea, Iran, and any jurisdiction subject to OFAC sanctions.',
        '• Representation: By using the Interface, you represent and warrant that you are NOT a resident, citizen, or located in any of these territories, and you are not using a VPN, proxy, or other technology to bypass these restrictions.',
        '• Enforcement: We reserve the right to implement technical geofencing and terminate access to anyone found violating these regional restrictions.',
      ],
    },
    {
      heading: '2. Description of Service',
      lines: [
        creator
          ? `${b} is a non-custodial trading interface on Hyperliquid, published through ${PLATFORM}. It may also feature a creator coin. The Interface does not execute trades, provide liquidity, or hold your funds. It lets you view markets and send orders you sign with your wallet.`
          : `${b} is a non-custodial software interface that lets creators launch branded Hyperliquid trading apps (tenants), optionally launch a creator coin, and let users deposit and trade through those apps. The Interface does not execute trades, provide liquidity, or hold your funds. It lets you configure apps, view markets, and send orders you sign with your wallet.`,
        '• Creator Apps: Public trading interfaces under a slug the creator chooses, with their branding, market catalog, and builder fee settings.',
        '• Trading: Spot and perpetual markets on Hyperliquid L1, accessed through the app shell.',
        '• Builder Fees: When a creator\'s builder wallet is activated, fills on their app can pay builder fees to that wallet per Hyperliquid builder codes.',
        `All trades and settlements are executed on-chain via Hyperliquid. ${b} is a software interface and is NOT a broker, financial advisor, or intermediary. Neither the creator nor the Company has access to, or custody of, your private keys or funds.`,
      ],
    },
    {
      heading: '3. Non-Custodial Nature & User Responsibility',
      lines: [
        `• No Custody: ${b} does not hold, custody, or control user funds, wallets, or trading positions at any time.`,
        '• Wallet Management: You can use our free embedded wallet service created via Privy. You are solely responsible for safeguarding your private keys, seed phrases, and wallet access.',
        `• Key Recovery: You can export your private keys from ${PRIVY_EXPORT_URL}. Use the same login method you used on ${b}. Privy is a trusted third-party wallet provider that we use to create your wallet.`,
        `• Acknowledgment of Risk: ${b} cannot recover, reverse, or restore any assets, positions, or transactions. All blockchain transactions are final and irreversible.`,
      ],
    },
    {
      heading: '4. Wallet and Unified Trade Balance',
      lines: [
        'The Interface shows your Wallet Balance on Arbitrum and your unified Trade Balance on Hyperliquid.',
        '• Wallet Balance: On Arbitrum, used for deposits and withdrawals to external wallets.',
        '• Unified Trade Balance: USDC on Hyperliquid L1 used as collateral for trading in creator apps.',
        'Moving funds between balances requires on-chain transactions. You acknowledge that moving from Trade Balance to Wallet Balance incurs a 1 USDC fee (L1 to L2 Bridge Fee).',
      ],
    },
    {
      heading: '5. Eligibility & Account Security',
      lines: [
        `You warrant that you are of legal age (18+ or your jurisdiction's age of majority) to use the Interface. You are responsible for all activities under your wallet and must immediately notify ${SUPPORT_EMAIL} of any unauthorized use.`,
      ],
    },
    {
      heading: '6. Fee Structure',
      lines: [
        'You agree to pay applicable fees for using the Interface. Exact amounts are shown in the Interface before you confirm each transaction.',
        `• Fees: ${PLATFORM} may charge platform fees for activating a builder wallet or launching a creator coin, as displayed in the Interface. Trading, bridge, deposit, and withdrawal costs are set by Hyperliquid or other protocol/third-party providers. ${creator ? `${b} charges` : 'Creator apps may charge'} a builder fee on fills as configured by the app owner and shown on the app page.`,
        `Funding rates and protocol fees on perpetual positions are determined by Hyperliquid, not ${b}.`,
      ],
    },
    {
      heading: '7. Trading Risks & Liquidation',
      lines: [
        '• High-Risk Activity: Leveraged futures trading is highly speculative and can result in total loss of your margin.',
        '• Liquidation Risk: If your perp position\'s losses exceed your available margin, it will be automatically liquidated.',
        '• Isolated Margin: Only the margin allocated to that specific position is at risk.',
        '• Cross / Unified Margin: Available margin on your unified trade balance can support eligible perpetual positions. One liquidation event can materially reduce the funds backing your leveraged positions.',
        '• Spot holdings: Buying spot exposes you to market price risk.',
        '• No Advice: Nothing in the Interface constitutes financial, legal, or tax advice. You are solely responsible for your trading decisions.',
      ],
    },
    {
      heading: '8. Creator Apps, Builder Wallets & Coins',
      lines: [
        '• App Ownership: The creator is responsible for the branding, social links, catalog, and fee settings they publish. Creators may not impersonate others or publish unlawful content.',
        '• Builder Wallet: Activating a builder requires meeting Hyperliquid\'s builder requirements (including maintaining the required USDC balance in Standard mode). Skipping activation may leave fees with the platform builder.',
        `• Creator Coins: Optional coin launches use third-party contracts and chains as disclosed in the Interface. Token launches involve risk of total loss; neither ${b} nor ${PLATFORM} guarantees liquidity, listing, or value.`,
      ],
    },
    {
      heading: '9. Third-Party Services',
      lines: [
        'The Interface integrates third-party services beyond our control:',
        '• Privy: Wallet creation and authentication',
        '• Arbitrum: Layer 2 blockchain for USDC deposits/withdrawals',
        '• Hyperliquid Protocol: Underlying DEX and settlement layer',
        '• Coin launch infrastructure: Third-party contracts used when a creator launches a coin',
        `You acknowledge that ${b} is not responsible for failures, inaccuracies, or changes to these services. Use of third-party services is subject to their respective terms.`,
      ],
    },
    {
      heading: '10. Deposits, Withdrawals & Transfers',
      lines: [
        '• Supported Asset: USDC (USD Coin) on Arbitrum network only for deposits into trade balance.',
        '• Deposit Methods: Direct USDC transfer to your wallet address or move wallet USDC into trade balance via the Interface.',
        '• Withdrawal: You can withdraw to any valid Arbitrum-compatible address. Withdrawals typically complete in minutes but are subject to network conditions.',
        '• Irreversibility: All blockchain transactions are final. Sending to incorrect addresses results in permanent loss of funds.',
        `• No Reversals: ${b} cannot reverse, cancel, or recover incorrectly sent transactions.`,
      ],
    },
    {
      heading: '11. One-Tap Trading & Authorizations',
      lines: [
        `By using the embedded Privy wallet session keys (one-tap trading feature), you authorize ${b} to execute trades on your behalf without requiring individual transaction approvals. You understand this convenience comes with responsibility to secure your device and account access.`,
      ],
    },
    {
      heading: '12. Protocol Dependency & Technical Risks',
      lines: [
        "The Interface's functionality depends entirely on external infrastructure:",
        '• Smart Contract Risk: Bugs or exploits in Hyperliquid or related contracts could result in loss of funds.',
        '• Network Congestion: High blockchain traffic may delay or prevent transactions.',
        '• Oracle / Market Data: Inaccurate protocol or oracle data could affect execution prices.',
        '• L1/L2 Bridge Risk: Cross-chain transfers involve technical risk.',
        `${b} is not liable for any losses resulting from protocol-level issues, network failures, or smart contract vulnerabilities.`,
      ],
    },
    {
      heading: '13. Prohibited Use',
      lines: [
        'You agree not to:',
        '• Use the Interface from jurisdictions where such services are prohibited',
        '• Engage in market manipulation, wash trading, or other fraudulent activities',
        '• Attempt to exploit bugs or vulnerabilities for financial gain',
        '• Use the Interface for money laundering or terrorist financing',
        '• Violate any applicable laws or regulations',
        '• Publish apps or content that infringe others\' rights or mislead users',
        'We reserve the right to restrict access at our discretion for any violation.',
      ],
    },
    {
      heading: '14. Limitation of Liability',
      lines: [
        'TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE COMPANY SHALL NOT BE LIABLE FOR:',
        '• Trading losses, including liquidations and adverse fills',
        '• Loss of funds due to user error or lost keys',
        '• Inaccurate price or market data from Hyperliquid or other third parties',
        '• Lost builder fees, misconfigured apps, or skipped builder activation',
        '• Any indirect, incidental, or consequential damages',
        'THE INTERFACE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND.',
      ],
    },
    {
      heading: '15. Indemnification',
      lines: [
        `You agree to indemnify, defend, and hold harmless ${b}, ${PLATFORM}, the Company, its affiliates, officers, directors, employees, and agents from any claims, damages, losses, liabilities, costs, or expenses (including legal fees) arising from:`,
        '• Your breach of these Terms',
        '• Your trading activity, app configuration, or creator-coin decisions',
        '• Your violation of any law or third-party rights',
        '• Your negligence or willful misconduct',
      ],
    },
    {
      heading: '16. Modifications & Termination',
      lines: [
        'We may modify these Terms at any time by updating the "Last Updated" date. Continued use after changes constitutes acceptance. We may suspend, restrict, or terminate your access for any breach or at our discretion without notice.',
      ],
    },
    {
      heading: '17. Governing Law & Dispute Resolution',
      lines: [
        'These Terms shall be governed by the laws of the State of Wyoming, USA. Any disputes shall be resolved through binding arbitration in Cheyenne, Wyoming, and you waive your right to a jury trial.',
      ],
    },
    {
      heading: '18. Severability & Entire Agreement',
      lines: [
        `If any provision is found unenforceable, the remaining provisions remain in effect. These Terms, together with our Privacy Policy, constitute the entire agreement between you and ${b}.`,
      ],
    },
    {
      heading: '19. No Solicitation (European Union)',
      lines: [
        `${b} does not target or solicit users in the European Union (EU). Access by users in the EU is at the user's 'exclusive initiative' (Reverse Solicitation). By using the Interface, you acknowledge that you have not been prompted to use the service via any marketing or advertising directed at the EU.`,
      ],
    },
    {
      heading: '20. Acknowledgment of Understanding',
      lines: [
        `BY USING ${b.toUpperCase()}, YOU ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND AGREE TO BE BOUND BY THESE TERMS. YOU UNDERSTAND THE RISKS OF TRADING, THE NON-CUSTODIAL NATURE OF THE TRADING WALLET, AND THE TECHNICAL DEPENDENCIES INVOLVED.`,
      ],
    },
    {
      heading: '21. Contact',
      lines: [
        'For questions or legal inquiries, please contact us at:',
        'LUNATIC WISDOM LABS LLC',
        'Capitol Ave Suite 413G-2320, Cheyenne, WYOMING 82001',
        SUPPORT_EMAIL,
        '+1 631 3939555 Ext. 101',
      ],
    },
  ];
}

function privacyFor(b: string): Section[] {
  const creator = b !== PLATFORM;
  return [
    {
      heading: '1. Introduction',
      lines: [
        creator
          ? `${b} is a creator app built on ${PLATFORM}, a non-custodial software interface ("the Interface") operated by LUNATIC WISDOM LABS LLC ("the Company," "we," "our"), a Wyoming limited liability company. This policy explains how we handle your data when you use ${b}.`
          : `${b} is a non-custodial software interface ("the Interface") operated by LUNATIC WISDOM LABS LLC ("the Company," "we," "our"), a Wyoming limited liability company. We provide tools to launch creator trading apps on Hyperliquid and to deposit and trade through those apps. This policy explains how we handle your data.`,
      ],
    },
    {
      heading: '2. Information We Collect',
      lines: [
        '• Wallet Data: We interact with your public wallet address and on-chain transaction history via Hyperliquid L1. We do NOT collect or store your private keys.',
        '• Authentication Data: If you use email or social login, this is managed by our partner, Privy. We only receive a unique identifier/email to manage your session.',
        '• App Data: If you create an app, we store the configuration you submit (name, slug, logo, socials, catalog, builder settings) to publish and operate your tenant.',
        '• Device & Location Data: We collect your IP address for geofencing compliance (trading restrictions) and basic device info (OS, browser type) for performance.',
        '• Usage Data: Anonymous information on Interface interactions (e.g., page views) to help us improve the software experience.',
      ],
    },
    {
      heading: '3. How We Use Information',
      lines: [
        '• Maintenance: To keep the Interface functional and resolve technical bugs.',
        '• Compliance: To enforce regional restrictions and geofencing as required by our Terms of Service.',
        `• Creator Apps: To publish ${creator ? b : 'your app'}, attribute fills, and display builder earnings summaries.`,
        '• Security: To detect fraudulent activity or potential exploits and comply with our legal obligations in Wyoming.',
        '• Communication: To provide support and respond to inquiries sent to our help desk.',
      ],
    },
    {
      heading: '4. How We Share Information',
      lines: [
        '• We share data with infrastructure providers (e.g., hosting, RPC nodes) necessary to run the Interface.',
        '• Privy: Your login data is managed by Privy under their privacy policy.',
        `• Public App Pages: Information a creator publishes on their app (name, logo, socials, markets) is public by design.${creator ? ` The creator of ${b} does not receive your email, wallet keys, or login data.` : ''}`,
        '• Law Enforcement: We may disclose information if required by a valid court order or to comply with Wyoming or US Federal law.',
      ],
    },
    {
      heading: '5. Data Retention & Deletion',
      lines: [
        '• Account Deletion: You can request to delete your Interface profile. We will scrub your email and usage logs from our internal systems where feasible.',
        '• Blockchain Exception: We cannot delete your data from Hyperliquid L1 or Arbitrum. On-chain data is permanent and beyond the control of the Company.',
        '• Published Apps: Public app content may remain available until the creator archives it or requests removal subject to our operational and legal requirements.',
      ],
    },
    {
      heading: '6. User Control & Wallet Ownership',
      lines: [
        '• Trading Wallet: You retain control of your self-custody trading wallet. The Company has no technical means to access your private keys, reverse on-chain trades, or recover lost seed phrases.',
      ],
    },
    {
      heading: '7. Data Security',
      lines: [
        'We use industry-standard encryption to protect data in transit, but you are the primary guardian of your security:',
        '• You are solely responsible for protecting your private keys and device access.',
        '• We cannot recover lost funds or compromised wallets.',
      ],
    },
    {
      heading: '8. Updates to This Policy',
      lines: [
        'We may update this policy to reflect changes in regulation. Continued use of the Interface after an update constitutes acceptance.',
      ],
    },
    {
      heading: '9. Contact Us',
      lines: [
        'For questions or legal inquiries, please contact us at:',
        'LUNATIC WISDOM LABS LLC',
        'Capitol Ave Suite 413G-2320, Cheyenne, WYOMING 82001',
        SUPPORT_EMAIL,
        '+1 631 3939555 Ext. 101',
      ],
    },
  ];
}

function useBrandName(): string {
  const tenant = useTenantBrand();
  return tenant?.app_name?.trim() || PLATFORM;
}

export function TermsPage() {
  const brand = useBrandName();
  return (
    <LegalArticle
      title={`Terms of Service for ${brand}`}
      subtitle={`Last Updated: ${LAST_UPDATED}`}
      sections={termsFor(brand)}
    />
  );
}

export function PrivacyPage() {
  const brand = useBrandName();
  return (
    <LegalArticle
      title={`Privacy Policy for ${brand}`}
      subtitle={`Last Updated: ${LAST_UPDATED}`}
      sections={privacyFor(brand)}
    />
  );
}
