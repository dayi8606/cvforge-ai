const $ = id => document.getElementById(id);
const fields = ["name","role","summary","experience","skills","education","certifications","jobDescription"];
let currentUser = null;

function getCV(){
  return Object.fromEntries(fields.map(id => [id, $(id).value]));
}
function setCV(cv={}){
  fields.forEach(id => { if (cv[id] !== undefined) $(id).value = cv[id] || ""; });
  render();
}
function render(){
  const cv=getCV();
  const esc=s=>String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
  const bullets=esc(cv.experience).split(/\n/).filter(Boolean).map(x=>x.replace(/^•\s*/,"")).map(x=>`<li>${x}</li>`).join("");
  const skills=esc(cv.skills).split(/[,\\n]/).map(x=>x.trim()).filter(Boolean).map(x=>`<li>${x}</li>`).join("");
  $("preview").innerHTML=`
    <h1>${esc(cv.name)||"Your Name"}</h1>
    <p><strong>${esc(cv.role)||"Target Role"}</strong></p>
    <h3>PROFESSIONAL SUMMARY</h3><p>${esc(cv.summary)||"Your professional summary will appear here."}</p>
    <h3>EXPERIENCE</h3><ul>${bullets||"<li>Your experience will appear here.</li>"}</ul>
    <h3>SKILLS</h3><ul>${skills||"<li>Your skills will appear here.</li>"}</ul>
    ${cv.education ? `<h3>EDUCATION</h3><p>${esc(cv.education)}</p>` : ""}
    ${cv.certifications ? `<h3>CERTIFICATIONS</h3><p>${esc(cv.certifications)}</p>` : ""}`;
}
fields.forEach(id=>$(id).addEventListener("input",render));

async function refreshAuth(){
  const r=await fetch("/api/auth/me");
  if(!r.ok){ $("authLink").textContent="Log in"; return; }
  const d=await r.json(); currentUser=d.user;
  $("authLink").textContent=`${d.user.name} · Log out`;
  $("authLink").onclick=async e=>{e.preventDefault();await fetch("/api/auth/logout",{method:"POST"});location.reload();};
  $("usage").textContent=`AI: ${d.aiUsage}/${d.aiLimit}`;
}
async function runAI(mode){
  if(!currentUser){ location.href="/auth.html"; return; }
  $("modal").classList.remove("hidden");
  $("modalText").textContent="CVForge AI is working on your CV...";
  try{
    const r=await fetch("/api/ai/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      mode, cv:getCV(), targetRole:$("role").value, jobDescription:$("jobDescription").value
    })});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||"AI request failed.");
    if(d.result.summary && (mode==="summary"||mode==="tailor")) $("summary").value=d.result.summary;
    if(Array.isArray(d.result.skills) && d.result.skills.length && (mode==="skills"||mode==="tailor")) $("skills").value=d.result.skills.join(", ");
    if(Array.isArray(d.result.experience) && d.result.experience.length && (mode==="experience"||mode==="tailor")){
      $("experience").value=d.result.experience.map(x=>`${x.role||""} — ${x.company||""}\n${(x.bullets||[]).map(b=>"• "+b).join("\n")}`).join("\n\n");
    }
    $("usage").textContent=`AI: ${d.used}/${d.limit}`;
    $("status").textContent="AI update applied to your CV.";
    render();
  }catch(e){$("status").textContent=e.message}
  finally{$("modal").classList.add("hidden")}
}
document.querySelectorAll(".ai-btn").forEach(b=>b.onclick=()=>runAI(b.dataset.mode));
$("generateBtn").onclick=()=>runAI("tailor");
$("closeModal").onclick=()=>$("modal").classList.add("hidden");
$("printBtn").onclick=()=>window.print();
async function checkout(plan){
  if(!currentUser){location.href="/auth.html";return;}
  const r=await fetch("/api/payments/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan})});
  const d=await r.json();
  if(!r.ok){$("status").textContent=d.error||"Checkout unavailable.";return;}
  if(d.url) location.href=d.url;
}
$("upgradeBtn").onclick=()=>checkout("pro");
$("careerBtn").onclick=()=>checkout("career");

$("saveBtn").onclick=async()=>{
  if(!currentUser){location.href="/auth.html";return}
  const title=$("name").value?`${$("name").value}'s CV`:"My CV";
  const r=await fetch("/api/cvs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,data:getCV(),template:document.querySelector("#template").value})});
  const d=await r.json(); $("status").textContent=r.ok?"CV saved to your account.":(d.error||"Could not save CV.");
};
render(); refreshAuth();

document.querySelector("#template").addEventListener("change", render);

$("downloadBtn").onclick = async () => {
  if(!currentUser){ location.href="/auth.html"; return; }
  $("status").textContent="Creating your PDF...";
  const title=$("name").value?`${$("name").value}'s CV`:"My CV";
  const save=await fetch("/api/cvs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,data:getCV(),template:document.querySelector("#template").value})});
  if(!save.ok){$("status").textContent="Could not save CV.";return;}
  const saved=await save.json();
  const pdf=await fetch(`/api/cvs/${saved.id}/pdf`,{method:"POST"});
  if(!pdf.ok){const d=await pdf.json().catch(()=>({}));$("status").textContent=d.error||"PDF generation failed.";return;}
  const blob=await pdf.blob();
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=`${title.replace(/[^a-z0-9]+/gi,"_")}.pdf`; a.click();
  URL.revokeObjectURL(url);
  $("status").textContent="PDF downloaded.";
};
