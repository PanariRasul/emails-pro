import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, patch, post, qs } from "../../api/client.js";
import { STALE, invalidate } from "../../lib/query.js";
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Table,
  Toggle,
  fmt,
  toast,
} from "../../components/ui.jsx";

const num = (v) => (v === "" || v == null ? null : Number(v));

export function EmployeeForm({ open, onClose, employee, defaults }) {
  const editing = Boolean(employee);
  const [f, setF] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(
      employee
        ? {
            ...employee,
            accountLimit: employee.accountLimit ?? "",
            dailyLimit: employee.dailyLimit ?? "",
            hourlyLimit: employee.hourlyLimit ?? "",
          }
        : {
            name: "",
            email: "",
            password: "",
            accountLimit: "",
            dailyLimit: "",
            hourlyLimit: "",
            requireApproval: false,
          },
    );
  }, [open, employee]);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const limits = {
        accountLimit: num(f.accountLimit),
        dailyLimit: num(f.dailyLimit),
        hourlyLimit: num(f.hourlyLimit),
        requireApproval: Boolean(f.requireApproval),
      };
      if (editing)
        await patch(`/api/admin/employees/${employee.id}`, {
          name: f.name,
          ...limits,
          sendingDisabled: Boolean(f.sendingDisabled),
          isActive: Boolean(f.isActive),
        });
      else
        await post("/api/admin/employees", {
          name: f.name,
          email: f.email,
          password: f.password,
          ...limits,
        });
      invalidate("admin");
      toast.ok(editing ? "Employee updated" : "Employee created");
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${employee.name}` : "New employee"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name">
          <input
            className="input"
            value={f.name || ""}
            onChange={set("name")}
          />
        </Field>
        <Field label="Email">
          <input
            className="input"
            type="email"
            value={f.email || ""}
            onChange={set("email")}
            disabled={editing}
          />
        </Field>
        {!editing && (
          <Field
            label="Initial password"
            hint="At least 10 characters. Ask them to change it."
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={f.password || ""}
              onChange={set("password")}
            />
          </Field>
        )}
        <Field
          label="Email account limit"
          hint={`Blank = default (${defaults?.accountLimit})`}
        >
          <input
            className="input"
            type="number"
            min="0"
            value={f.accountLimit}
            onChange={set("accountLimit")}
          />
        </Field>
        <Field
          label="Daily sending limit — all accounts together"
          hint={`Total emails per day across every mailbox this employee connects (10 or 100). Blank = default (${defaults?.dailyLimit})`}
        >
          <input
            className="input"
            type="number"
            min="0"
            value={f.dailyLimit}
            onChange={set("dailyLimit")}
          />
        </Field>
        <Field
          label="Max emails/hour per account"
          hint={`Blank = default (${defaults?.hourlyLimit})`}
        >
          <input
            className="input"
            type="number"
            min="0"
            value={f.hourlyLimit}
            onChange={set("hourlyLimit")}
          />
        </Field>
        <div className="space-y-2 md:col-span-2">
          <Toggle
            checked={f.requireApproval}
            onChange={(v) => setF((s) => ({ ...s, requireApproval: v }))}
            label="Require admin approval before campaigns start"
          />
          {editing && (
            <Toggle
              checked={f.sendingDisabled}
              onChange={(v) => setF((s) => ({ ...s, sendingDisabled: v }))}
              label="Sending disabled (emergency stop for this employee)"
            />
          )}
          {editing && (
            <Toggle
              checked={f.isActive}
              onChange={(v) => setF((s) => ({ ...s, isActive: v }))}
              label="Active (unchecking signs them out everywhere)"
            />
          )}
        </div>
      </div>
      <div className="mt-3">
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Employees() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ open: false, employee: null });
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("new") === "1") {
      setForm({ open: true, employee: null });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "employees", { page, search }],
    queryFn: () =>
      get(`/api/admin/employees${qs({ page, pageSize: 25, search })}`),
    staleTime: STALE.admin,
  });
  return (
    <>
      <PageHeader
        title="Employees"
        subtitle="Create employees and set their account and sending limits"
        actions={
          <Button
            variant="brand"
            onClick={() => setForm({ open: true, employee: null })}
          >
            New employee
          </Button>
        }
      />
      <Card
        padded={false}
        actions={
          <input
            className="input w-56"
            placeholder="Search name or email"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        }
        title="All employees"
      >
        {error && <ErrorBox error={error} />}
        {isLoading && !data ? (
          <Loading />
        ) : (
          <Table
            head={[
              "Employee",
              "Status",
              "Accounts",
              "Daily limit",
              "Hourly/account",
              "Working campaigns",
              "Sent today",
              "Last login",
              "",
            ]}
          >
            {(data?.items || []).map((u) => (
              <tr key={u.id}>
                <td className="td">
                  <Link
                    className="font-medium text-brand-700 dark:text-brand-300 hover:underline"
                    to={`/admin/employees/${u.id}`}
                  >
                    {u.name}
                  </Link>
                  <div className="text-xs text-muted">{u.email}</div>
                </td>
                <td className="td space-x-1">
                  {u.isActive ? (
                    <Badge color="green">active</Badge>
                  ) : (
                    <Badge color="red">inactive</Badge>
                  )}
                  {u.sendingDisabled && <Badge color="red">sending off</Badge>}
                  {u.requireApproval && <Badge color="purple">approval</Badge>}
                </td>
                <td className="td">
                  {u.accounts} / {u.effective.accounts}
                  <div className="text-xs text-muted">
                    {u.accountsRemaining} left
                    {u.accountLimit == null && " · default"}
                  </div>
                </td>
                <td className="td">
                  {u.effective.daily}
                  {u.dailyLimit == null && (
                    <span className="text-xs text-faint"> (default)</span>
                  )}
                </td>
                <td className="td">
                  {u.effective.hourly}
                  {u.hourlyLimit == null && (
                    <span className="text-xs text-faint"> (default)</span>
                  )}
                </td>
                <td className="td">{u.workingCampaigns}</td>
                <td className="td">{u.sentToday}</td>
                <td className="td text-xs">{fmt.rel(u.lastLoginAt)}</td>
                <td className="td">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setForm({ open: true, employee: u })}
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {data && (
          <Pagination
            page={page}
            pageSize={25}
            total={data.total}
            onPage={setPage}
          />
        )}
      </Card>
      <EmployeeForm
        open={form.open}
        employee={form.employee}
        defaults={data?.defaults}
        onClose={() => setForm({ open: false, employee: null })}
      />
    </>
  );
}
