let token = '', consentEpoch;
const element = id => document.getElementById(id);
const randomKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
async function api(path, input, credential = token) {
  const response = await fetch(path, { method: input === undefined ? 'GET' : 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${credential}`, 'Idempotency-Key': randomKey(),
  }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result;
}
function action(id, handler) {
  const target = element(id);
  target.addEventListener(target.tagName === 'FORM' ? 'submit' : 'click', async event => {
    event.preventDefault();
    const buttons = [...target.querySelectorAll('button'), ...(target.tagName === 'BUTTON' ? [target] : [])];
    buttons.forEach(button => { button.disabled = true; });
    try { await handler(target); element('status').textContent = '操作完成。'; }
    catch (error) { element('status').textContent = error.message; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  });
}
action('redeem', async form => { const session = await api('/api/participants/redeem', { token: form.elements.invitation.value }, ''); token = session.token; consentEpoch = undefined; form.reset(); element('records').textContent = '邀请已兑换，请确认当前版本的同意。'; });
action('consent', async () => { const result = await api('/api/private/command', { action: 'consent', type: 'private_intake', version: '2026-09', accepted: true }); consentEpoch = result.consentEpoch; });
action('intake', async form => { if (consentEpoch === undefined) throw new Error('请先确认同意。'); await api('/api/private/command', { action: 'create', type: 'private_intake', consentEpoch, payload: { message: form.elements.message.value } }); form.reset(); });
action('activity', async () => { element('records').textContent = JSON.stringify(await api('/api/private/self'), null, 2); });
action('logout', async () => { await api('/api/auth/logout', {}); token = ''; consentEpoch = undefined; element('records').textContent = '已退出本设备，同意仍保留。'; });
action('withdraw', async () => { if (!confirm('撤回会清除本人线索并退出所有设备，确认撤回？')) return; await api('/api/private/command', { action: 'withdraw' }); token = ''; consentEpoch = undefined; element('records').textContent = '已撤回同意。'; });
action('report', async form => { const result = await api('/api/reports', { message: form.elements.message.value }, ''); element('report-result').textContent = `请保存状态回执：${result.receipt}`; form.reset(); });
action('receipt', async form => { element('report-result').textContent = JSON.stringify(await api('/api/reports/status', undefined, form.elements.receipt.value), null, 2); });
