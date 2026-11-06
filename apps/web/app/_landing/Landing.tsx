// The signed-out front door. Sign in with Discord is the only action, so the page's job is to
// show what's on the other side of it: the bot answering at the table, the memory behind it,
// and the fog of war that keeps each player to what their character actually knows.
// Pure server markup + CSS (./landing.css); the only interactivity is the sign-in form.

import "./landing.css";
import { signInWithDiscord } from "./actions";

function DiscordMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.84a13.7 13.7 0 0 0-.63 1.3 18.4 18.4 0 0 0-5.53 0 12.6 12.6 0 0 0-.64-1.3 19.7 19.7 0 0 0-4.93 1.53C.54 9.06-.31 13.63.12 18.13a19.9 19.9 0 0 0 6.04 3.05c.49-.66.92-1.36 1.3-2.1a12.9 12.9 0 0 1-2.04-.98c.17-.13.34-.26.5-.39a14.2 14.2 0 0 0 12.16 0c.16.14.33.27.5.39-.65.39-1.33.71-2.05.98.38.74.81 1.44 1.3 2.1a19.8 19.8 0 0 0 6.05-3.05c.5-5.22-.86-9.75-3.56-13.76ZM8.02 15.37c-1.18 0-2.16-1.09-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42Zm7.97 0c-1.19 0-2.16-1.09-2.16-2.42s.95-2.42 2.16-2.42c1.2 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Z" />
    </svg>
  );
}

function Flame({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="flame-g" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#c2410c" />
          <stop offset="0.55" stopColor="#f59e0b" />
          <stop offset="1" stopColor="#fde68a" />
        </linearGradient>
      </defs>
      <path
        fill="url(#flame-g)"
        d="M16 2c1.2 4.6-1.6 6.8-3.6 9.4-1.7 2.2-2.9 4.1-2.9 7 0 1.6.5 3 1.3 4.2-.2-2.6 1.1-4.4 2.8-5.8-.1 2.2.9 3.6 2.4 4.5-.3-2.9 1.4-5.6 3.6-7.4.3 2.4 1.9 3.8 2.6 6 .5 1.6.2 3.4-.6 4.9 2.4-1.5 3.9-4.1 3.9-7.1C27.5 10.4 20.9 7.2 16 2Z"
      />
      <path
        fill="#fff7ed"
        opacity=".85"
        d="M16.3 19.2c-1.6 1.3-2.6 2.8-2.6 4.8a3.9 3.9 0 0 0 7.8.2c0-1.9-1-3.1-2.2-4.2-.2 1.2-.9 2-1.9 2.4.4-1.1.1-2.2-1.1-3.2Z"
      />
    </svg>
  );
}

function SignInButton({ big = false }: { big?: boolean }) {
  return (
    <form action={signInWithDiscord}>
      <button
        className={big ? "ld-discord ld-discord-big" : "ld-discord"}
        type="submit"
      >
        <DiscordMark size={big ? 22 : 18} />
        Sign in with Discord
      </button>
    </form>
  );
}

const EMBERS = Array.from({ length: 22 }, (_, i) => i);

const FEATURES = [
  {
    icon: "🎙️",
    title: "Session capture",
    body: "The bot sits in voice, transcribes each speaker, and turns the night into memory — no note-taker required.",
  },
  {
    icon: "📜",
    title: "Recaps on demand",
    body: "“Catch me up.” A tight recap of last session before anyone has finished pouring drinks.",
  },
  {
    icon: "🗝️",
    title: "A codex that writes itself",
    body: "NPCs, places, factions and loot, pulled from play and searchable — each entry cites the session it came from.",
  },
  {
    icon: "🎭",
    title: "NPCs in a heartbeat",
    body: "Need a shifty harbormaster now? Claude invents one that fits your world, and you keep the parts you like.",
  },
  {
    icon: "🔮",
    title: "DM prep that knows the table",
    body: "Open threads, who hasn’t had the spotlight, what the party still hasn’t asked about. Yours alone.",
  },
  {
    icon: "✒️",
    title: "Corrections & reveals",
    body: "Fix what the memory got wrong. Reveal a secret to one character, the party, or everyone — and take it back.",
  },
];

export function Landing() {
  return (
    <div className="ld">
      {/* ── nav ─────────────────────────────────────────────── */}
      <header className="ld-nav">
        <a className="ld-brand" href="#top">
          <Flame className="ld-brand-flame" />
          Hearth
        </a>
        <SignInButton />
      </header>

      {/* ── hero ────────────────────────────────────────────── */}
      <section className="ld-hero" id="top">
        <div className="ld-glow" aria-hidden="true" />
        <div className="ld-embers" aria-hidden="true">
          {EMBERS.map((i) => (
            <span
              key={i}
              style={
                {
                  left: `${(i * 47) % 100}%`,
                  width: 2 + (i % 3) * 1.5,
                  animationDuration: `${7 + ((i * 13) % 9)}s`,
                  animationDelay: `${i * -0.9}s`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>

        <div className="ld-hero-copy">
          <p className="ld-kicker">A memory for your D&amp;D table</p>
          <h1 className="ld-title">
            Every session remembered.
            <br />
            <em>Only what your character knows.</em>
          </h1>
          <p className="ld-lede">
            Hearth lives in your Discord. It listens to the table, keeps the
            whole campaign in one living memory, and answers each player from
            behind their own fog of war.
          </p>
          <div className="ld-cta-row">
            <SignInButton big />
            <span className="ld-cta-note">
              No new account — the same Discord your table already uses.
            </span>
          </div>
        </div>

        {/* mock Discord exchange */}
        <div
          className="ld-chat"
          aria-label="Example: a player asks the Hearth bot a question in Discord"
        >
          <div className="ld-chat-bar">
            <span className="ld-hash">#</span> the-yawning-portal
          </div>
          <div className="ld-msg">
            <div className="ld-avatar ld-av-player">V</div>
            <div>
              <div className="ld-msg-head">
                <b>Vex</b> <span className="ld-time">Today at 9:41 PM</span>
              </div>
              <div className="ld-slash">
                <span>/ask</span> who sold us the map to the Sunken Vault?
              </div>
            </div>
          </div>
          <div className="ld-msg ld-msg-bot">
            <div className="ld-avatar ld-av-bot">
              <Flame />
            </div>
            <div>
              <div className="ld-msg-head">
                <b>Hearth</b> <span className="ld-bot-tag">APP</span>
                <span className="ld-time">Today at 9:41 PM</span>
              </div>
              <div className="ld-embed">
                <p>
                  <b>Marrow Quill</b>, the one-eyed cartographer in Saltreach.
                  She wanted 40 gold and “a favor, later.” Vex haggled her down
                  to 25 — the favor is still owed.
                </p>
                <p className="ld-source">
                  ⟡ From Session 4 · The Drowned Market
                </p>
              </div>
              <div className="ld-ephemeral">👁 Only you can see this</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── fog of war ──────────────────────────────────────── */}
      <section className="ld-section">
        <p className="ld-kicker">The fog of war</p>
        <h2 className="ld-h2">One question. Two very different answers.</h2>
        <p className="ld-sub">
          Every read goes through a permission filter. The DM sees the whole
          board; each player sees exactly what their character has learned —
          nothing leaks, not even in a shared channel.
        </p>

        <div className="ld-fog">
          <div className="ld-fog-card">
            <div className="ld-fog-who">
              <span className="ld-pill ld-pill-dm">Dungeon Master</span>
            </div>
            <p className="ld-fog-q">“What do we know about Marrow Quill?”</p>
            <ul className="ld-facts">
              <li>Cartographer in Saltreach; sold the party the Vault map.</li>
              <li>Owed one favor by Vex.</li>
              <li>
                Secretly an agent of the Drowned Choir — the map leads into
                their trap.
              </li>
              <li>Her missing eye is in the Vault’s reliquary.</li>
            </ul>
          </div>

          <div className="ld-fog-card ld-fog-player">
            <div className="ld-fog-who">
              <span className="ld-pill">Vex · Player</span>
            </div>
            <p className="ld-fog-q">“What do we know about Marrow Quill?”</p>
            <ul className="ld-facts">
              <li>Cartographer in Saltreach; sold the party the Vault map.</li>
              <li>Owed one favor by Vex.</li>
              <li className="ld-fogged" aria-label="Hidden: not yet learned">
                <span>
                  Secretly an agent of the Drowned Choir — the map leads in.
                </span>
              </li>
              <li className="ld-fogged" aria-label="Hidden: not yet learned">
                <span>Her missing eye is in the Vault’s reliquary.</span>
              </li>
            </ul>
            <p className="ld-fog-note">
              Two things you haven’t discovered yet.
            </p>
          </div>
        </div>
      </section>

      {/* ── how it works ────────────────────────────────────── */}
      <section className="ld-section">
        <p className="ld-kicker">How it works</p>
        <h2 className="ld-h2">Pull up a chair.</h2>
        <ol className="ld-steps">
          <li>
            <span className="ld-step-n">1</span>
            <h3>Invite the bot</h3>
            <p>
              Add Hearth to your table’s server. Players link up with{" "}
              <code>/join</code>.
            </p>
          </li>
          <li>
            <span className="ld-step-n">2</span>
            <h3>Play like you always do</h3>
            <p>
              Hearth listens in voice and folds each session into the campaign’s
              memory.
            </p>
          </li>
          <li>
            <span className="ld-step-n">3</span>
            <h3>Ask anything</h3>
            <p>
              In Discord or here on the web — answers cite the session they came
              from.
            </p>
          </li>
        </ol>
      </section>

      {/* ── features ────────────────────────────────────────── */}
      <section className="ld-section">
        <p className="ld-kicker">Around the fire</p>
        <h2 className="ld-h2">Everything your table forgets, kept warm.</h2>
        <div className="ld-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="ld-feature">
              <span className="ld-feature-icon" aria-hidden="true">
                {f.icon}
              </span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── closing CTA ─────────────────────────────────────── */}
      <section className="ld-final">
        <div className="ld-final-glow" aria-hidden="true" />
        <Flame className="ld-final-flame" />
        <h2 className="ld-h2">The fire’s lit. Your table is waiting.</h2>
        <p className="ld-sub">
          Sign in with the Discord account your campaign already knows.
        </p>
        <SignInButton big />
      </section>

      <footer className="ld-footer">
        <span>
          <Flame className="ld-foot-flame" /> Hearth
        </span>
        <span>Not a virtual tabletop — the memory that sits beside one.</span>
      </footer>
    </div>
  );
}
