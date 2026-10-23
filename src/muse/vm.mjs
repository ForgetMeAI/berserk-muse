function vmDescriptor(value, { allowMissingId = false, legacyEndpoint = false, trimLabels = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.endpoint_url !== 'string' || value.endpoint_url.length > 4096) return null;
  let url;
  try { url = new URL(value.endpoint_url); } catch { return null; }
  if (legacyEndpoint) {
    if (!['https:', 'http:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
  } else if (!['https:', 'wss:'].includes(url.protocol) || !url.hostname.endsWith('.metaaivm.com') ||
    (url.port && url.port !== '443') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    return null;
  }

  const rawVmNameValue = value.vm_name ?? value.name ?? value.vmName ?? value.id;
  const rawVmNameText = trimLabels && typeof rawVmNameValue === 'string' ? rawVmNameValue.trim() : rawVmNameValue;
  const rawVmIdValue = value.vm_id;
  const rawVmId = trimLabels && typeof rawVmIdValue === 'string' ? rawVmIdValue.trim() : rawVmIdValue;
  const rawVmName = rawVmNameText === '' ? null : rawVmNameText;
  if ((!allowMissingId && (typeof rawVmId !== 'string' || rawVmId.length === 0)) ||
    (rawVmId != null && (typeof rawVmId !== 'string' || rawVmId.length === 0 || rawVmId.length > 255)) ||
    (rawVmName != null && (typeof rawVmName !== 'string' || rawVmName.length === 0 || rawVmName.length > 255))) return null;
  const vmName = rawVmName ?? null;
  const vmId = rawVmId ?? vmName;
  if (typeof vmId !== 'string' || vmId.length === 0 || vmId.length > 255) return null;
  return { gatewayUrl: url.href, vmId, ...(vmName ? { vmName } : {}) };
}

/** Resolve the known Muse VM session shapes without treating unrecognized payloads as assignments. */
export function resolveMuseSessionVm(value, { allowLegacyDirect = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown' };
  if (typeof value.endpoint_url === 'string') {
    if (value.status !== undefined && value.status !== 'assigned') return { kind: 'unknown' };
    const descriptor = vmDescriptor(value, {
      allowMissingId: value.status === 'assigned',
      legacyEndpoint: allowLegacyDirect && value.status === undefined,
      trimLabels: allowLegacyDirect && value.status === undefined,
    });
    return descriptor ? { kind: 'vm', descriptor } : { kind: 'unknown' };
  }

  const status = value.status;
  if (status === 'none' || status === 'unavailable') return { kind: 'unavailable' };
  if (status !== 'assigned' && !(status === undefined && Array.isArray(value.vms))) return { kind: 'unknown' };
  if (!Array.isArray(value.vms)) return { kind: 'unknown' };
  const inventory = value.vms.filter(item => item && typeof item === 'object' && !Array.isArray(item));
  const preferred = inventory.find(item => item.is_preferred === true && typeof item.endpoint_url === 'string' && item.endpoint_url.length > 0);
  const selected = preferred ?? inventory.find(item => typeof item.endpoint_url === 'string' && item.endpoint_url.length > 0);
  if (!selected) return status === undefined && inventory.length === 0 ? { kind: 'unavailable' } : { kind: 'unknown' };
  const descriptor = vmDescriptor(selected, { allowMissingId: true });
  return descriptor ? { kind: 'vm', descriptor } : { kind: 'unknown' };
}
