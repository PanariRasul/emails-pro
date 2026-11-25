import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, probeHealth } from "../../api/client.js";
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  Stat,
  Table,
  fmt,
  toast,
} from "../../components/ui.jsx";

// Client-side availability monitor: runs only while this page is open, at an admin-chosen interval.
// It is a monitor, not a keep-alive — it does not (and cannot) keep Render Free from sleeping.
function useClientMonitor(intervalMin, enabled) {
  const [log, setLog] = useState([]);
  const last = useRef(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let stop = false;
    const run = async () => {
      const r = await probeHealth();
      if (stop) return;
      const entry = { at: Date.now(), ...r };
      setLog((l) => [entry, ...l].slice(0, 100));
      if (last.current !== null && last.current !== r.ok) {
        const msg = r.ok
          ? `Emails Pro API recovered (${r.ms} ms)`
          : "Emails Pro API is unavailable";
        if (r.ok) toast.ok(msg);
        else toast.error({ message: msg });
        if ("Notification" in window && Notification.permission === "granted")
          new Notification("Emails Pro", { body: msg });
      }
      last.current = r.ok;
    };
    run();
    const t = setInterval(run, Math.max(1, intervalMin) * 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [intervalMin, enabled]);
  return log;
}

const Dot = ({ ok }) => (
  <span
    className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`}
  />
);

export default function Health() {
  const [intervalMin, setIntervalMin] = useState(5);
  const [monitoring, setMonitoring] = useState(true);
  const log = useClientMonitor(intervalMin, monitoring);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin", "monitoring"],
    queryFn: () => get("/api/admin/monitoring"),
    staleTime: 30_000,
  });
  const lastOk = log.find((l) => l.ok);
  const failures = log.filter((l) => !l.ok).length;
  const avg = log
    .filter((l) => l.ok)
    .reduce((s, l, _, a) => s + l.ms / a.length, 0);

  return (
    <>
      <PageHeader
        title="System health"
        subtitle="API, database and worker status"
        actions={
          <Button
            variant="secondary"
            loading={isFetching}
            onClick={() => refetch()}
          >
            Refresh
          </Button>
        }
      />
      <div className="mb-4 rounded-2xl border border-line bg-card px-4 py-3 text-sm text-fg2">
        Render Free services sleep after a period without traffic, and Neon
        suspends idle compute. The first request after that can take up to a
        minute. Health checks here observe that — they do not keep the service
        awake, and 24/7 availability is not possible on the free plan.
      </div>
      {error && !data && <ErrorBox error={error} />}
      {isLoading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <Stat
                label="API"
                value={
                  <span className="flex items-center gap-2">
                    <Dot ok={data.api.ok} /> up{" "}
                    {Math.round(data.api.uptimeSec / 60)} min
                  </span>
                }
                hint={`RSS ${data.api.memoryMb.rss} MB · heap ${data.api.memoryMb.heapUsed} MB`}
                tone={data.api.memoryMb.rss > 420 ? "warn" : undefined}
              />
              <Stat
                label="Database"
                value={
                  <span className="flex items-center gap-2">
                    <Dot ok={data.database.ok} />{" "}
                    {data.database.latencyMs ?? "—"} ms
                  </span>
                }
                hint={`last ok check ${fmt.rel(data.database.lastSuccessfulCheck)}`}
              />
              {data.worker.mode === "serverless" ? (
                <Stat
                  label="Worker (serverless)"
                  value={
                    <span className="flex items-center gap-2">
                      <Dot
                        ok={
                          data.worker.heartbeatAgeSec != null &&
                          data.worker.heartbeatAgeSec < 600
                        }
                      />{" "}
                      {data.worker.heartbeatAgeSec == null
                        ? "never ran"
                        : "runs in passes"}
                    </span>
                  }
                  hint={`last pass ${data.worker.heartbeatAgeSec ?? "—"}s ago · runs while the app is used and on each /api/cron/tick call`}
                />
              ) : (
                <Stat
                  label="Worker"
                  value={
                    <span className="flex items-center gap-2">
                      <Dot
                        ok={
                          data.worker.leader &&
                          data.worker.heartbeatAgeSec < 180
                        }
                      />{" "}
                      {data.worker.leader ? "leader" : "standby"}
                    </span>
                  }
                  hint={`heartbeat ${data.worker.heartbeatAgeSec ?? "—"}s ago · ${data.worker.activeCampaigns} sending`}
                />
              )}
              <Stat
                label="Outbound SMTP"
                value={
                  data.smtpEgress?.status === "restricted"
                    ? "Blocked"
                    : data.smtpEgress?.status === "open"
                      ? "Open"
                      : "Unknown"
                }
                tone={
                  data.smtpEgress?.status === "restricted" ? "warn" : undefined
                }
                hint={
                  data.smtpEgress?.status === "restricted"
                    ? `Ports ${data.smtpEgress.blockedPorts.join(", ")} blocked — use Gmail API / SES API / port 2525`
                    : "Ports 465/587 reachable"
                }
              />
              <Stat
                label="Redis"
                value={
                  data.redis?.configured === false ? (
                    "Not used"
                  ) : (
                    <span className="flex items-center gap-2">
                      <Dot ok={data.redis?.ok} /> {data.redis?.latencyMs ?? "—"}{" "}
                      ms
                    </span>
                  )
                }
                hint="Optional — PostgreSQL is the source of truth"
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-5">
              <Stat
                label="Event loop p99"
                value={`${data.api.eventLoopDelayMs.p99} ms`}
              />
              <Stat
                label="Unknown sends"
                value={data.queue.unknownSends}
                tone={data.queue.unknownSends ? "warn" : undefined}
              />
              <Stat label="On hold" value={data.queue.onHold} />
              <Stat
                label="Accounts in error"
                value={data.queue.accountsInError}
                tone={data.queue.accountsInError ? "warn" : undefined}
              />
              <Stat label="IMAP errors" value={data.queue.imapErrors} />
            </div>
            {data.worker.lastError && (
              <div className="mt-4">
                <ErrorBox
                  error={{
                    message: `Last worker error (${data.worker.lastError.task}, ${fmt.rel(data.worker.lastError.at)}): ${data.worker.lastError.message}`,
                  }}
                />
              </div>
            )}

            {data.queue.stalledCampaigns.length > 0 && (
              <Card
                title="Possibly stuck campaigns (sending, no progress for 2h)"
                className="mt-4"
                padded={false}
              >
                <Table head={["Campaign", "Employee", "Pending", "Last sent"]}>
                  {data.queue.stalledCampaigns.map((c) => (
                    <tr key={c.id}>
                      <td className="td">{c.name}</td>
                      <td className="td">{c.owner}</td>
                      <td className="td">{c.pending}</td>
                      <td className="td text-xs">{fmt.date(c.lastSentAt)}</td>
                    </tr>
                  ))}
                </Table>
                <p className="px-3 py-2 text-xs text-muted">
                  Common causes: quota reached, account paused/disconnected,
                  warm-up cap, or the service was asleep.
                </p>
              </Card>
            )}

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card title="Server-side check history (24h)" padded={false}>
                <Table
                  head={["Time", "Component", "Result", "Latency", "Detail"]}
                >
                  {data.timeline.map((c) => (
                    <tr key={c.id}>
                      <td className="td text-xs">{fmt.date(c.createdAt)}</td>
                      <td className="td text-xs">{c.component}</td>
                      <td className="td">
                        {c.ok ? (
                          <Badge color="green">ok</Badge>
                        ) : (
                          <Badge color="red">fail</Badge>
                        )}
                      </td>
                      <td className="td text-xs">{c.latencyMs ?? "—"}</td>
                      <td className="td max-w-xs text-xs text-muted">
                        {c.detail}
                      </td>
                    </tr>
                  ))}
                </Table>
              </Card>
              <Card
                title="Live availability monitor (this browser)"
                actions={
                  <>
                    <Field>
                      <select
                        className="input w-32"
                        value={intervalMin}
                        onChange={(e) => setIntervalMin(Number(e.target.value))}
                      >
                        {[1, 5, 10, 15, 30].map((m) => (
                          <option key={m} value={m}>
                            every {m} min
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setMonitoring((m) => !m)}
                    >
                      {monitoring ? "Stop" : "Start"}
                    </Button>
                    {"Notification" in window &&
                      Notification.permission === "default" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => Notification.requestPermission()}
                        >
                          Enable alerts
                        </Button>
                      )}
                  </>
                }
              >
                <div className="mb-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <div className="label">Last success</div>
                    {lastOk ? fmt.rel(lastOk.at) : "—"}
                  </div>
                  <div>
                    <div className="label">Avg response</div>
                    {avg ? `${Math.round(avg)} ms` : "—"}
                  </div>
                  <div>
                    <div className="label">Failures</div>
                    {failures} / {log.length}
                  </div>
                </div>
                <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
                  {log.map((l) => (
                    <li key={l.at} className="flex items-center gap-2">
                      <Dot ok={l.ok} /> {new Date(l.at).toLocaleTimeString()} —{" "}
                      {l.ok
                        ? `${l.ms} ms${l.ms > 5000 ? " (cold start)" : ""}`
                        : `failed (${l.error || l.status})`}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
            <p className="mt-3 text-xs text-faint">{data.note}</p>
          </>
        )
      )}
    </>
  );
}
