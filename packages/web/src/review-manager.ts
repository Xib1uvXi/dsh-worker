import type {
  Action,
  ReviewPool,
  ReviewStatus,
} from "../../contracts/src/index.js";
export function mountReviewManager(api: {
  request<T>(path: string, action?: Action): Promise<T>;
  onChange(): Promise<unknown>;
}) {
  const dialog = document.getElementById("review-manager") as HTMLDialogElement;
  const form = document.getElementById("review-pool-form") as HTMLFormElement;
  const error = document.getElementById("review-manager-error")!;
  const pools = document.getElementById("review-pools")!;
  const runs = document.getElementById("review-run-list")!;
  let current: ReviewStatus | undefined;
  const text = (tag: "p" | "h3" | "pre", value: string) => {
    const e = document.createElement(tag);
    e.textContent = value;
    return e;
  };
  const button = (label: string, fn: () => Promise<unknown>) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = () => {
      b.disabled = true;
      void fn()
        .then(refresh)
        .catch((e) => {
          error.textContent = String(e);
        })
        .finally(() => {
          b.disabled = false;
        });
    };
    return b;
  };
  const change = async (action: Action) => {
    await api.request("/api/actions", action);
    await api.onChange();
  };
  const config = (p: ReviewPool, state: ReviewPool["state"]) => ({
    poolId: p.poolId,
    batchId: p.batchId,
    expectedVersion: p.version,
    implementationLimit: p.pendingLimit ?? p.implementationLimit,
    state,
    execution: p.execution,
    entrySkills: p.entrySkills,
  });
  const refresh = async () => {
    current = await api.request<ReviewStatus>("/api/reviews");
    error.textContent = "";
    pools.replaceChildren(
      text("p", `服务总占槽 ${current.capacityOwned} / ${current.capacity}`),
    );
    runs.replaceChildren();
    for (const p of current.pools) {
      const section = document.createElement("section");
      section.className = "review-form";
      section.append(
        text(
          "h3",
          `${p.poolId} · ${p.state}${p.pendingLimit ? ` · 排空至 ${p.pendingLimit}` : ""}`,
        ),
        text(
          "p",
          `实现占槽 ${p.implementationOwned} / ${p.implementationLimit} · 审查占槽 ${p.reviewOwned} / ${p.implementationLimit} · 待审 ${p.queued} · 最久等待 ${p.oldestWaitSeconds ?? 0} 秒`,
        ),
      );
      section.append(
        button("编辑配额", async () => {
          for (const [k, v] of Object.entries({
            poolId: p.poolId,
            batchId: p.batchId,
            limit: p.implementationLimit,
            reviewProvider: p.execution.provider,
            reviewModel: p.execution.model,
          }))
            (form.elements.namedItem(k) as HTMLInputElement).value = String(v);
          form.closest("details")!.open = true;
        }),
        button(p.state === "enabled" ? "暂停新增" : "恢复调度", () =>
          change({
            action: "review-pool",
            pool: config(p, p.state === "enabled" ? "paused" : "enabled"),
          }),
        ),
        button("关闭已排空池", () =>
          change({ action: "review-pool", pool: config(p, "closed") }),
        ),
      );
      pools.append(section);
    }
    for (const r of [...current.runs].reverse()) {
      const section = document.createElement("section");
      section.className = "review-form";
      section.append(
        text("h3", `${r.request.ticketId} · ${r.state} · ${r.phase}`),
        text(
          "p",
          `池 ${r.request.poolId} · 占槽 ${r.slotHeld ? "是" : "否"} · ${r.suspended ? "需显式恢复调度" : ""} · 建议 ${r.report?.recommendation ?? "尚无报告"}；不代表验收`,
        ),
      );
      section.append(
        text(
          "p",
          `证据适用性 ${r.applicability}${r.applicabilityReason ? ": " + r.applicabilityReason : ""}`,
        ),
      );
      if (r.error) section.append(text("p", r.error));
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "来源与完整证据";
      details.append(summary, text("pre", JSON.stringify(r, null, 2)));
      section.append(details);
      if (r.state === "queued" || r.state === "running")
        section.append(
          button("取消审查", () =>
            change({ action: "cancel-review", runId: r.id }),
          ),
        );
      if (r.state === "interrupted" && r.slotHeld)
        section.append(
          button("核对并释放审查进程", () =>
            change({ action: "recover-review", runId: r.id }),
          ),
        );
      runs.append(section);
    }
    for (const o of current.operations) {
      const row = document.createElement("section");
      row.append(
        text(
          "p",
          `${o.ticketId} · ${o.kind} · ${o.state}${o.suspended ? " · 暂停" : ""}${o.error ? ` · ${o.error}` : ""}`,
        ),
      );
      if (o.state === "queued")
        row.append(
          button("撤销排队操作", () =>
            change({ action: "cancel-scheduled", requestId: o.requestId }),
          ),
        );
      runs.append(row);
    }
  };
  document.getElementById("nav-reviews")!.onclick = () => {
    dialog.showModal();
    void refresh().catch((e) => {
      error.textContent = String(e);
    });
  };
  document.getElementById("close-review-manager")!.onclick = () =>
    dialog.close();
  document.getElementById("refresh-reviews")!.onclick = () => {
    void refresh().catch((e) => {
      error.textContent = String(e);
    });
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const get = (key: string) => String(data.get(key) ?? "");
    const old = current?.pools.find((p) => p.poolId === get("poolId"));
    void change({
      action: "review-pool",
      pool: {
        poolId: get("poolId"),
        batchId: get("batchId"),
        expectedVersion: old?.version ?? 0,
        implementationLimit: Number(get("limit")),
        state: "enabled",
        entrySkills: old?.entrySkills ?? [],
        execution: {
          timeoutSeconds: 600,
          patches: [],
          envRequired: [],
          credentialEnv: ["DEEPSEEK_API_KEY"],
          ...old?.execution,
          provider: get("reviewProvider"),
          model: get("reviewModel"),
        },
      },
    })
      .then(refresh)
      .catch((e) => {
        error.textContent = String(e);
      });
  };
}
