// ---------------------------------------------------------------------------
// ReClip frontend — prismatic edition
// ---------------------------------------------------------------------------
const form        = document.getElementById("download-form");
const urlInput    = document.getElementById("url");
const presetInput = document.getElementById("preset");
const subsCheck   = document.getElementById("subtitles");
const submitBtn   = document.getElementById("submit-btn");
const submitLabel = document.getElementById("submit-label");

const activeJob   = document.getElementById("active-job");
const activeTitle = document.getElementById("active-title");
const activeStage = document.getElementById("active-stage");
const fill        = document.getElementById("progress-fill");
const pctEl       = document.getElementById("progress-pct");
const speedEl     = document.getElementById("progress-speed");
const etaEl       = document.getElementById("progress-eta");
const bytesEl     = document.getElementById("progress-bytes");

const historyGrid = document.getElementById("history-grid");
const historyEmpty = document.getElementById("history-empty");
const refreshBtn  = document.getElementById("refresh-history");

// ---------------------------------------------------------------------------
// Custom preset dropdown
// ---------------------------------------------------------------------------
const presetDropdown = document.getElementById("preset-dropdown");
const presetButton   = document.getElementById("preset-button");
const presetLabel    = document.getElementById("preset-label");
const presetMenu     = document.getElementById("preset-menu");
let presetOptions    = Array.from(document.querySelectorAll(".preset-option"));

function setPreset(key, label) {
  presetInput.value = key;
  presetLabel.textContent = label;
  presetOptions.forEach(o => {
    const on = o.dataset.preset === key;
    o.querySelector(".check").classList.toggle("opacity-0", !on);
    o.querySelector(".check").classList.toggle("opacity-100", on);
  });
  if (typeof updateCliCommand === "function") updateCliCommand();
}
// initialise with whatever is currently marked
if (presetOptions.length) {
  const first = presetOptions[0];
  setPreset(first.dataset.preset, first.textContent.trim());
}

presetButton.addEventListener("click", (e) => {
  e.stopPropagation();
  presetDropdown.classList.toggle("open");
});
presetOptions.forEach(opt => {
  opt.addEventListener("click", () => {
    setPreset(opt.dataset.preset, opt.querySelector("span").textContent);
    presetDropdown.classList.remove("open");
  });
});
document.addEventListener("click", (e) => {
  if (presetDropdown && !presetDropdown.contains(e.target)) presetDropdown.classList.remove("open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && presetDropdown) presetDropdown.classList.remove("open");
});

function attachPresetListeners() {
  presetOptions = Array.from(document.querySelectorAll(".preset-option"));
  presetOptions.forEach(opt => {
    opt.addEventListener("click", () => {
      setPreset(opt.dataset.preset, opt.querySelector("span").textContent);
      presetDropdown.classList.remove("open");
    });
  });
}
attachPresetListeners();

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function humanBytes(n) {
  if (!n && n !== 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
function humanEta(s) {
  if (!s) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function humanTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60)     return "just now";
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `Today, ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
  if (diff < 172800) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); }
  catch { return url.slice(0, 40); }
}
function isAudioPreset(p) {
  return p && (p.startsWith("mp3") || p === "m4a");
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function refreshHistory() {
  try {
    const r = await fetch("/api/jobs");
    const jobs = await r.json();
    if (!jobs.length) {
      historyGrid.innerHTML = "";
      historyEmpty.classList.remove("hidden");
      return;
    }
    historyEmpty.classList.add("hidden");
    historyGrid.innerHTML = jobs.map(renderJob).join("");
    historyGrid.querySelectorAll("[data-delete]").forEach(b => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this entry?")) return;
        await fetch(`/api/jobs/${b.dataset.delete}`, { method: "DELETE" });
        refreshHistory();
      });
    });
  } catch (err) {
    console.error("history refresh failed", err);
  }
}

function renderJob(j) {
  const title = j.title || hostOf(j.url);
  const audio = isAudioPreset(j.preset);
  const icon  = audio ? "audio_file" : "movie";

  let statusChip, statusColor, actionRow;

  if (j.status === "running") {
    statusChip  = "Running";
    statusColor = "primary";
    actionRow   = "";
  } else if (j.status === "error") {
    statusChip  = "Failed";
    statusColor = "error";
    actionRow   = `<p class="mt-3 text-[14px] text-[#ffb4ab]/80 line-clamp-2">${escapeHtml((j.error || "").slice(0, 140))}</p>`;
  } else if (j.status === "done" && !j.file_exists) {
    statusChip  = "Expired Link";
    statusColor = "error";
    actionRow   = "";
  } else {
    statusChip  = "Completed";
    statusColor = "primary";
    actionRow   = "";
  }

  const isError = statusColor === "error";
  const chipBorder = isError ? "border-[#ffb4ab]/20" : "border-[#d8b4fe]/20";
  const chipText   = isError ? "text-[#ffb4ab]" : "text-[#d8b4fe]";
  const iconBg     = isError ? "bg-[#ffb4ab]/10" : "bg-white/5";
  
  const titleOpacity = isError ? "text-white/80" : "text-white";
  const metaOpacity  = isError ? "text-white/20" : "text-white/30";

  const sizeBadge = (j.status === "done" && j.file_exists && j.filesize)
    ? ` · ${humanBytes(j.filesize)}`
    : "";

  const canDownload = j.status === "done" && j.file_exists;
  const actions = `
    <div class="absolute top-4 right-4 z-20 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      ${canDownload ? `
        <a href="/download/${j.id}" download
           class="w-10 h-10 rounded-full bg-[#111417]/80 hover:bg-[#d8b4fe] hover:text-black border border-white/10 flex items-center justify-center text-white/80 transition-all shadow-xl"
           title="Download file">
          <span class="material-symbols-outlined text-[18px] font-bold">download</span>
        </a>` : ""}
      <button type="button" data-delete="${j.id}"
              class="w-10 h-10 rounded-full bg-[#111417]/80 hover:bg-[#ffb4ab]/20 hover:text-[#ffb4ab] hover:border-[#ffb4ab]/30 border border-white/10 flex items-center justify-center text-white/60 transition-all shadow-xl"
              title="Delete entry">
        <span class="material-symbols-outlined text-[18px]">close</span>
      </button>
    </div>`;

  const hostLine = j.url
    ? `<span class="font-body text-[15px] ${metaOpacity} flex items-center gap-2.5 truncate">
         <span class="material-symbols-outlined text-[18px]">public</span>${escapeHtml(hostOf(j.url))}
       </span>`
    : "";

  return `
    <div class="job-card bg-surface-container-low p-8 rounded-[32px] flex flex-col justify-between min-h-[300px] border border-white/5 hover:border-white/10 transition-colors group relative overflow-hidden">
      ${!isError
        ? `<div class="absolute inset-0 bg-prismatic opacity-0 group-hover:opacity-[0.04] transition-opacity duration-500 pointer-events-none"></div>`
        : `<div class="absolute top-0 right-0 w-[120px] h-[120px] bg-[#ffb4ab]/10 blur-[60px] rounded-full pointer-events-none"></div>`}
      ${actions}
      <div class="flex items-start justify-between z-10 w-full gap-2">
        <div class="${iconBg} w-[52px] h-[52px] rounded-2xl flex items-center justify-center ${chipText} shrink-0">
          <span class="material-symbols-outlined text-[24px]">${icon}</span>
        </div>
        <div class="${chipText} font-bold text-[11px] uppercase tracking-wider px-4 py-1.5 rounded-full border ${chipBorder}">${statusChip}</div>
      </div>
      <div class="z-10 mt-12 w-full min-w-0">
        <h3 class="font-headline text-[24px] font-bold ${titleOpacity} mb-3 truncate group-hover:text-prismatic transition-colors" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
        <div class="flex items-center justify-between mt-4 min-w-0 gap-4">
          ${hostLine}
          <span class="font-body text-[14px] text-white/30 truncate shrink-0">${humanTime(j.created_at)}${sizeBadge}</span>
        </div>
        ${actionRow}
      </div>
    </div>`;
}

refreshBtn.addEventListener("click", refreshHistory);

// ---------------------------------------------------------------------------
// Submit & CLI Fallback
// ---------------------------------------------------------------------------
let analysisCompleteFor = null;
let activeBrowser = "chrome";

const browserBtns = document.querySelectorAll(".browser-btn");
const cliCommandEl = document.getElementById("cli-command");
const copyCliBtn = document.getElementById("copy-cli");

browserBtns.forEach(btn => {
    btn.addEventListener("click", () => {
        activeBrowser = btn.dataset.browser;
        browserBtns.forEach(b => {
             const on = (b === btn);
             b.className = on 
                ? "browser-btn px-4 py-2 rounded-xl border border-[#d8b4fe]/30 bg-[#d8b4fe]/10 text-white text-[14px] font-medium transition-colors cursor-pointer" 
                : "browser-btn px-4 py-2 rounded-xl border border-white/5 bg-transparent text-white/50 hover:bg-white/5 hover:text-white text-[14px] font-medium transition-colors cursor-pointer";
        });
        updateCliCommand();
    });
});

function updateCliCommand() {
    if (!cliCommandEl) return;
    const url = urlInput.value.trim() || "https://...";
    let format = presetInput.value;
    let formatFlag = `-f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best"`;
    
    if (format && format.startsWith("id:")) {
        formatFlag = `-f "${format.slice(3)}" --merge-output-format mp4`;
    }

    const command = `yt-dlp --cookies-from-browser ${activeBrowser} ${formatFlag} "${url}"`;
    cliCommandEl.textContent = command;
}

if (copyCliBtn) {
    copyCliBtn.addEventListener("click", () => {
        if (cliCommandEl) {
            navigator.clipboard.writeText(cliCommandEl.textContent);
            const icon = document.getElementById("copy-icon");
            icon.textContent = "check";
            icon.classList.replace("text-white/60", "text-[#a7f3d0]");
            setTimeout(() => {
                icon.textContent = "content_copy";
                icon.classList.replace("text-[#a7f3d0]", "text-white/60");
            }, 2000);
        }
    });
}

function resetSubmit() {
  submitBtn.disabled = false;
  submitLabel.textContent = "Download";
  document.querySelector('.drop-icon').textContent = 'download';
  document.querySelector('.drop-icon').classList.remove('animate-spin');
}

function showActive(stage, title) {
  activeJob.classList.remove("hidden");
  activeStage.textContent = stage;
  activeTitle.textContent = title;
}

urlInput.addEventListener("input", () => {
    if (urlInput.value.trim() !== analysisCompleteFor) {
        analysisCompleteFor = null;
        document.getElementById("metadata-preview").classList.add("hidden");
        document.getElementById("preset-dropdown").classList.add("hidden");
        document.getElementById("preset-dropdown").classList.remove("flex");
        document.getElementById("subtitles-container").classList.add("hidden");
        document.getElementById("cli-fallback-panel").classList.add("hidden");
        submitLabel.textContent = "Analyze Engine";
        document.querySelector('.drop-icon').textContent = 'bolt';
    }
});

async function goAnalyze(url) {
  submitBtn.disabled = true;
  submitLabel.textContent = "Analyzing...";
  document.querySelector('.drop-icon').textContent = 'sync';
  document.querySelector('.drop-icon').classList.add('animate-spin');

  try {
    const r = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    if (!r.ok) throw new Error("Extracting metadata failed.");
    const data = await r.json();

    document.getElementById("meta-title").textContent = data.title || "Encrypted Artifact";
    document.getElementById("meta-host-text").textContent = data.host || "Unknown Core";
    document.getElementById("meta-thumb").src = data.thumbnail || "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
    
    let html = "";
    data.options.forEach(opt => {
       const sizeStr = opt.size ? humanBytes(opt.size) : "UKN MB";
       html += `<button type="button" data-preset="${opt.id}" class="preset-option w-full text-left px-5 py-3 text-sm font-headline text-white hover:bg-white/10 transition-colors flex items-center justify-between">
              <span>${opt.label} · ${sizeStr}</span>
              <span class="material-symbols-outlined text-[#d8b4fe] text-sm opacity-0 check font-bold">check</span>
            </button>`;
    });
    presetMenu.innerHTML = html;
    
    attachPresetListeners();
    if (presetOptions.length) {
      const first = presetOptions[0];
      setPreset(first.dataset.preset, first.querySelector("span").textContent);
    }

    document.getElementById("metadata-preview").classList.remove("hidden");
    document.getElementById("metadata-preview").classList.add("flex");
    document.getElementById("preset-dropdown").classList.remove("hidden");
    document.getElementById("preset-dropdown").classList.add("flex");
    document.getElementById("subtitles-container").classList.remove("hidden");
    
    // Check if contextual Local CLI is needed
    if (data.host && (data.host.toLowerCase().includes("youtube") || data.host.toLowerCase().includes("instagram"))) {
        document.getElementById("cli-fallback-panel").classList.remove("hidden");
        updateCliCommand();
    }
    
    analysisCompleteFor = url;
    submitLabel.textContent = "Download";
    document.querySelector('.drop-icon').textContent = 'download';
    document.querySelector('.drop-icon').classList.remove('animate-spin');
    submitBtn.disabled = false;
  } catch (err) {
    showActive("ERROR", err.message);
    resetSubmit();
    
    // If the server was blocked but it's a known restricted host, show the local fallback anyway
    const L = url.toLowerCase();
    if (L.includes("youtube.com") || L.includes("youtu.be") || L.includes("instagram.com")) {
        document.getElementById("cli-fallback-panel").classList.remove("hidden");
        if (typeof updateCliCommand === "function") updateCliCommand();
    }
    submitLabel.textContent = "Analyze Engine";
    document.querySelector('.drop-icon').textContent = 'bolt';
    document.querySelector('.drop-icon').classList.remove('animate-spin');
    submitBtn.disabled = false;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  if (analysisCompleteFor !== url) {
    await goAnalyze(url);
    return;
  }

  submitBtn.disabled = true;
  submitLabel.textContent = "Starting…";
  document.querySelector('.drop-icon').classList.add('animate-spin');
  showActive("INITIALIZING", "Fetching data streams…");
  fill.style.width = "0%";
  fill.classList.add("shimmer");
  pctEl.textContent = "0%";
  speedEl.textContent = "";
  etaEl.textContent = "";
  bytesEl.textContent = "";

  let jobId;
  try {
    const r = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        preset: presetInput.value,
        subtitles: subsCheck.checked,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ detail: "unknown error" }));
      throw new Error(err.detail);
    }
    const j = await r.json();
    jobId = j.job_id;
  } catch (err) {
    showActive("ERROR", "Error: " + err.message);
    fill.classList.remove("shimmer");
    resetSubmit();
    return;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/progress/${jobId}`);

  ws.onmessage = (evt) => {
    const d = JSON.parse(evt.data);
    if (d.type === "progress") {
      const pct = d.pct || 0;
      fill.style.width = pct + "%";
      pctEl.textContent = pct.toFixed(1) + "%";
      speedEl.textContent = d.speed ? humanBytes(d.speed) + "/s" : "";
      etaEl.textContent   = d.eta   ? "ETA " + humanEta(d.eta) : "";
      bytesEl.textContent = (d.downloaded != null)
        ? `${humanBytes(d.downloaded)}${d.total ? " / " + humanBytes(d.total) : ""}`
        : "";
      showActive("DOWNLOADING", "Streaming artifact…");
    } else if (d.type === "postprocess") {
      showActive("PROCESSING", "Target acquired… mapping streams.");
      fill.style.width = "100%";
      pctEl.textContent = "100%";
      speedEl.textContent = "";
      etaEl.textContent = "";
    } else if (d.type === "done") {
      showActive("COMPLETE", d.title || d.filename);
      fill.classList.remove("shimmer");
      refreshHistory();
      window.location.href = `/download/${d.job_id}`;
      analysisCompleteFor = null;
      urlInput.value = "";
    } else if (d.type === "error") {
      showActive("FAILED", d.error || "Unknown error");
      fill.classList.remove("shimmer");
      refreshHistory();
    } else if (d.type === "end") {
      resetSubmit();
    }
  };

  ws.onerror = () => {
    showActive("DISCONNECTED", "Connection to master lost");
    fill.classList.remove("shimmer");
    resetSubmit();
  };
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
refreshHistory();
setInterval(refreshHistory, 10000);
