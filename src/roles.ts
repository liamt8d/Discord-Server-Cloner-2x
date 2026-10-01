export function normaliseRoleName(original: string, fallback: string) {
  const source = typeof original === 'string' ? original : '';
  let name = source.replace(/\p{Cc}/gu, '');
  const reasons: string[] = [];
  // Old servers can contain spacer roles which the creation API now rejects.
  const visible = name.replace(/[\p{White_Space}\p{Cf}\p{M}\u2800\u3164\uffa0\u115f\u1160]/gu, '');
  if (!visible) { name = fallback; reasons.push('Nombre vacío o invisible: se usa un nombre de respaldo.'); }
  else if (name !== source) reasons.push('Se retiraron caracteres de control del nombre.');
  if (name.length > 100) {
    let shortened = '';
    for (const character of name) {
      if (shortened.length + character.length > 100) break;
      shortened += character;
    }
    name = shortened;
    reasons.push('Nombre recortado al límite de 100, sin partir caracteres Unicode.');
  }
  return { name, changed: name !== source, reason: reasons.join(' ') };
}
