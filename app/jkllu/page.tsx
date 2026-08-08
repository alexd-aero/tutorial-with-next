export default function Docs() {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-deployment.app";

  return (
    <main style={{
      background: "#090d16",
      color: "#f1f5f9",
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      minHeight: "100vh",
      padding: "3rem 1.5rem",
    }}>
      <div style={{ maxWidth: "800px", margin: "0 auto" }}>

        <div style={{
          display: "inline-block",
          background: "rgba(99,102,241,0.15)",
          border: "1px solid rgba(99,102,241,0.3)",
          borderRadius: "999px",
          padding: "4px 14px",
          fontSize: "12px",
          color: "#a5b4fc",
          marginBottom: "1.5rem",
          letterSpacing: "0.05em",
        }}>
          INTERNAL DOCS · NOT LINKED
        </div>

        <h1 style={{
          fontSize: "2.25rem",
          fontWeight: 800,
          marginBottom: "0.5rem",
          background: "linear-gradient(90deg, #fff, #a5b4fc)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
        }}>
          Proxy Engine Usage Guide
        </h1>
        <p style={{ color: "#94a3b8", marginBottom: "2.5rem", fontSize: "1rem" }}>
          All requests are Base64-encoded into URL segments. Both routes are unified — they auto-detect HTML to rewrite links, or stream raw API/binary responses.
        </p>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.08)", marginBottom: "2rem" }} />

        {/* Encoding */}
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700, color: "#c7d2fe", marginBottom: "1rem" }}>
            1 · Encoding a Target URL
          </h2>
          <p style={{ color: "#94a3b8", fontSize: "0.9rem", marginBottom: "0.75rem" }}>
            Encode your destination URL as standard Base64 (or URL-safe Base64 with <code style={code}>-</code> and <code style={code}>_</code> instead of <code style={code}>+</code> and <code style={code}>/</code>):
          </p>
          <pre style={pre}>
{`// Browser
btoa("https://api.github.com/users/octocat")
// => "aHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS91c2Vycy9vY3RvY2F0"

// Node.js
Buffer.from("https://example.com").toString("base64")`}
          </pre>
        </section>

        {/* Routes */}
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700, color: "#c7d2fe", marginBottom: "1rem" }}>
            2 · Proxy Routes
          </h2>

          <div style={card}>
            <div style={{ color: "#a5b4fc", fontWeight: 700, marginBottom: "6px", fontFamily: "monospace" }}>
              GET /{"{base64_url}"}
            </div>
            <p style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
              Unified proxy. Auto-detects response type. Returns raw streamed API data, or rewrites HTML links for transparent web browsing.
            </p>
          </div>

          <div style={{ ...card, marginTop: "0.75rem" }}>
            <div style={{ color: "#c084fc", fontWeight: 700, marginBottom: "6px", fontFamily: "monospace" }}>
              GET /wbpge/{"{base64_url}"}
            </div>
            <p style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
              Alias for the same unified handler. Useful for bookmarking web-browsing sessions.
            </p>
          </div>
        </section>

        {/* Methods */}
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700, color: "#c7d2fe", marginBottom: "1rem" }}>
            3 · Supported HTTP Methods
          </h2>
          <p style={{ color: "#94a3b8", fontSize: "0.9rem", marginBottom: "0.75rem" }}>
            All methods are forwarded. Request body is streamed via <code style={code}>ReadableStream</code> with <code style={code}>duplex: half</code>:
          </p>
          <pre style={pre}>{"GET  POST  PUT  DELETE  PATCH  HEAD  OPTIONS"}</pre>
        </section>

        {/* Examples */}
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700, color: "#c7d2fe", marginBottom: "1rem" }}>
            4 · cURL Examples
          </h2>

          <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "6px" }}>GET — GitHub API</p>
          <pre style={pre}>
{`curl -i "https://your-deployment.app/aHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS91c2Vycy9vY3RvY2F0"`}
          </pre>

          <p style={{ color: "#64748b", fontSize: "0.8rem", margin: "1rem 0 6px" }}>GET — Streaming / SSE (unbuffered)</p>
          <pre style={pre}>
{`curl -i -N "https://your-deployment.app/{base64_sse_endpoint}"`}
          </pre>

          <p style={{ color: "#64748b", fontSize: "0.8rem", margin: "1rem 0 6px" }}>POST with JSON body</p>
          <pre style={pre}>
{`curl -X POST \\
  -H "Content-Type: application/json" \\
  -d '{"key":"value"}' \\
  "https://your-deployment.app/{base64_post_url}"`}
          </pre>

          <p style={{ color: "#64748b", fontSize: "0.8rem", margin: "1rem 0 6px" }}>Browse a webpage (links auto-rewritten)</p>
          <pre style={pre}>
{`curl "https://your-deployment.app/wbpge/aHR0cHM6Ly9leGFtcGxlLmNvbQ=="`}
          </pre>
        </section>

        {/* Notes */}
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700, color: "#c7d2fe", marginBottom: "1rem" }}>
            5 · Notes
          </h2>
          <ul style={{ color: "#94a3b8", fontSize: "0.9rem", lineHeight: "2", paddingLeft: "1.25rem" }}>
            <li>All rewritten HTML links use <strong style={{ color: "#f1f5f9" }}>root-relative paths</strong> so browsing stays on the deployment host, not your local IP.</li>
            <li>Hop-by-hop headers (<code style={code}>host</code>, <code style={code}>connection</code>, <code style={code}>transfer-encoding</code>, <code style={code}>cf-*</code>) are automatically stripped from forwarded requests.</li>
            <li>CORS is fully open: <code style={code}>Access-Control-Allow-Origin: *</code></li>
            <li>System paths like <code style={code}>favicon.ico</code>, <code style={code}>robots.txt</code>, and <code style={code}>healthz</code> return 404 and are not proxied.</li>
            <li>URLs without a protocol prefix are assumed <code style={code}>https://</code>.</li>
          </ul>
        </section>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", marginBottom: "1.5rem" }} />
        <p style={{ color: "#334155", fontSize: "0.75rem" }}>Internal use only · Not linked from root</p>
      </div>
    </main>
  );
}

const pre: React.CSSProperties = {
  background: "#0f172a",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: "10px",
  padding: "1rem 1.25rem",
  fontSize: "0.8rem",
  fontFamily: "'JetBrains Mono', 'Consolas', monospace",
  color: "#e2e8f0",
  overflowX: "auto",
  whiteSpace: "pre",
};

const code: React.CSSProperties = {
  background: "rgba(99,102,241,0.15)",
  color: "#a5b4fc",
  borderRadius: "4px",
  padding: "1px 6px",
  fontSize: "0.82em",
  fontFamily: "monospace",
};

const card: React.CSSProperties = {
  background: "rgba(15,23,42,0.8)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: "12px",
  padding: "1rem 1.25rem",
};
