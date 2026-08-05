const toast = document.querySelector(".toast");
const navLinks = [...document.querySelectorAll(".docs-nav a")];
const docSections = [...document.querySelectorAll(".doc-section[id]")];
let toastTimer;
const copyRestoreTimers = new WeakMap();

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("copy failed");
  }
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    try {
      await copyText(target.textContent.trim());
      showToast("已复制");
      const previousTimer = copyRestoreTimers.get(button);
      if (previousTimer) window.clearTimeout(previousTimer);
      button.textContent = "已复制";
      button.classList.add("copied");
      const restoreTimer = window.setTimeout(() => {
        button.textContent = "复制";
        button.classList.remove("copied");
        copyRestoreTimers.delete(button);
      }, 1800);
      copyRestoreTimers.set(button, restoreTimer);
    } catch {
      showToast("复制失败，请手动选择");
    }
  });
});

if (docSections.length > 0) {
  let scrollFrame;
  const updateActiveSection = () => {
    const atPageEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    const activationLine = Math.min(180, window.innerHeight * 0.28);
    let activeSection = docSections[0];
    for (const section of docSections) {
      if (section.getBoundingClientRect().top <= activationLine) activeSection = section;
    }
    if (atPageEnd) activeSection = docSections[docSections.length - 1];
    navLinks.forEach((link) => link.classList.toggle("active", link.hash === `#${activeSection.id}`));
  };
  const scheduleActiveSectionUpdate = () => {
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = window.requestAnimationFrame(updateActiveSection);
  };
  window.addEventListener("scroll", scheduleActiveSectionUpdate, { passive: true });
  window.addEventListener("resize", scheduleActiveSectionUpdate);
  updateActiveSection();
}
