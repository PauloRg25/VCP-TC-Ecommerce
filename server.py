"""Servidor local del portal B2B: sirve los archivos estáticos y expone
POST /api/enviar-odf para la prueba interna de envío de correo (Fase 1).

Ejecutar:  python server.py
Variables SMTP: ver .env.example (crear un .env local, nunca subir credenciales).
"""

import json
import os
import smtplib
import traceback
from email.message import EmailMessage
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Prueba interna: el correo del cliente se ignora siempre, sin importar lo que
# llegue en el payload del ODF. Solo estos destinatarios reciben el envío.
DESTINATARIO_PRUEBA = "ejecutivoventas1@laumayer.com.ec"
CC_PRUEBA = ["gerenteventasr1@laumayer.com.ec", "atencion.uio@laumayer.com.ec"]


# =========================================================
# DIAGNÓSTICO TEMPORAL (seguro: nunca imprime credenciales completas)
# =========================================================

def _resumen_caracteres_sospechosos(nombre, valor):
    """Reporta posicion/codepoint de caracteres no-ASCII o de control, sin revelar el valor."""
    hallazgos = [
        (posicion, hex(ord(caracter)))
        for posicion, caracter in enumerate(valor)
        if ord(caracter) > 127 or ord(caracter) < 32 or ord(caracter) == 127
    ]
    if hallazgos:
        print(f"[DIAGNOSTICO] {nombre}: caracteres sospechosos (posicion, codepoint) = {hallazgos}")
    else:
        print(f"[DIAGNOSTICO] {nombre}: sin caracteres no-ASCII/control detectados")


def _comparar_fuente_env(clave, valor_env_file):
    """Compara el valor leido directamente del .env contra el que ya hubiera en
    os.environ (variable heredada de la sesion de shell), sin imprimir el secreto.
    """
    valor_os_environ = os.environ.get(clave)
    if valor_os_environ is None:
        print(f"[DIAGNOSTICO] {clave}: no existia previamente en os.environ (solo vendra del .env).")
        return

    coinciden = valor_os_environ == valor_env_file
    print(
        f"[DIAGNOSTICO] {clave} YA EXISTIA en os.environ antes de cargar .env. "
        f"coincide_con_.env={coinciden}"
    )
    print(
        f"[DIAGNOSTICO]   .env        -> longitud={len(valor_env_file)} "
        f"isascii={valor_env_file.isascii()} "
        f"codepoints={[hex(ord(c)) for c in valor_env_file]}"
    )
    print(
        f"[DIAGNOSTICO]   os.environ  -> longitud={len(valor_os_environ)} "
        f"isascii={valor_os_environ.isascii()} "
        f"codepoints={[hex(ord(c)) for c in valor_os_environ]}"
    )
    if not coinciden:
        print(
            f"[DIAGNOSTICO] ALERTA: {clave} en os.environ (variable heredada del shell) "
            "difiere del .env. Sin la correccion de prioridad, setdefault() habria "
            "usado el valor viejo de os.environ en lugar del .env."
        )


def cargar_env():
    """Carga variables desde un .env local (formato CLAVE=VALOR), sin dependencias externas.

    Prioridad: .env SIEMPRE gana sobre cualquier variable ya presente en el entorno
    del shell (se asigna directamente en vez de os.environ.setdefault()).
    """
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        print("[DIAGNOSTICO] No se encontro .env; se usaran variables de entorno del sistema.")
        return

    crudo = env_path.read_bytes()
    print(f"[DIAGNOSTICO] .env encontrado: {len(crudo)} bytes, primeros bytes (hex)={crudo[:8].hex()}")
    if crudo.startswith((b"\xff\xfe", b"\xfe\xff")):
        print("[DIAGNOSTICO] ALERTA: el .env parece estar en UTF-16 (BOM detectado), no UTF-8.")
    elif crudo.startswith(b"\xef\xbb\xbf"):
        print("[DIAGNOSTICO] .env tiene BOM UTF-8 (normalmente inofensivo).")

    texto = crudo.decode("utf-8", errors="replace")
    for numero_linea, linea in enumerate(texto.splitlines(), start=1):
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, _, valor = linea.partition("=")
        clave = clave.strip()
        valor = valor.strip()
        _resumen_caracteres_sospechosos(f".env linea {numero_linea} ({clave})", valor)
        if clave == "SMTP_PASSWORD":
            _comparar_fuente_env(clave, valor)
        os.environ[clave] = valor  # .env tiene prioridad sobre variables heredadas del shell


cargar_env()

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER)
SMTP_USE_TLS = os.environ.get("SMTP_USE_TLS", "true").lower() != "false"

print(f"[DIAGNOSTICO] SMTP_HOST={SMTP_HOST!r}  SMTP_PORT={SMTP_PORT}  SMTP_USE_TLS={SMTP_USE_TLS}")
print(f"[DIAGNOSTICO] len(SMTP_USER)={len(SMTP_USER)}  len(SMTP_PASSWORD)={len(SMTP_PASSWORD)}  len(SMTP_FROM)={len(SMTP_FROM)}")
_resumen_caracteres_sospechosos("SMTP_USER (carga inicial)", SMTP_USER)
_resumen_caracteres_sospechosos("SMTP_PASSWORD (carga inicial)", SMTP_PASSWORD)
_resumen_caracteres_sospechosos("SMTP_FROM (carga inicial)", SMTP_FROM)


def money(valor):
    try:
        return f"${float(valor):.2f}"
    except (TypeError, ValueError):
        return str(valor)


def construir_cuerpo_correo(odf):
    cliente = odf.get("cliente", {}) or {}
    comercial = odf.get("comercial", {}) or {}
    resumen = odf.get("resumen", {}) or {}
    detalle = odf.get("detalle", []) or []
    bodega = detalle[0].get("bodega", "-") if detalle else "-"

    lineas = [
        f"Numero ODF: {odf.get('numero', '-')}",
        f"Fecha: {odf.get('fecha', '-')}",
        "",
        f"Cliente: {cliente.get('empresa', '-')}",
        f"RUC: {cliente.get('ruc', '-')}",
        f"Bodega: {bodega}",
        f"Vendedor: {comercial.get('responsable', '-')}",
        f"Descuento VTC: {comercial.get('descuentoPorcentaje', '-')}",
        "",
        "DETALLE DE PRODUCTOS",
        "-" * 70,
    ]

    for item in detalle:
        lineas.append(f"[{item.get('item')}] {item.get('codigo')} - {item.get('descripcion')}")
        lineas.append(
            f"    Cantidad: {item.get('cantidad')}  "
            f"Precio lista: {money(item.get('precioLista'))}  "
            f"Descuento: {item.get('descuentoPorcentaje')}  "
            f"Precio neto: {money(item.get('precioNetoUnitario'))}  "
            f"Total linea: {money(item.get('precioTotal'))}"
        )
        lineas.append(
            f"    Stock disponible: {item.get('stockDisponible')}  "
            f"Estado: {item.get('estadoStock')}"
        )
        lineas.append("")

    lineas.append("-" * 70)
    lineas.append(f"SUBTOTAL: {money(resumen.get('subtotal'))}")
    lineas.append(f"IVA 15%: {money(resumen.get('iva'))}")
    lineas.append(f"TOTAL: {money(resumen.get('total'))}")
    lineas.append("")
    lineas.append(
        "Prueba interna del portal B2B VCP Electric. "
        "El cliente NO fue incluido en este envio."
    )

    return "\n".join(lineas)


def enviar_correo(odf):
    if not SMTP_HOST or not SMTP_USER or not SMTP_PASSWORD:
        raise RuntimeError(
            "Faltan variables SMTP_HOST/SMTP_USER/SMTP_PASSWORD. "
            "Copia .env.example a .env y completa tus credenciales antes de enviar."
        )

    # --- Diagnostico seguro antes de tocar la red (no imprime credenciales completas) ---
    print("[DIAGNOSTICO] Validando variables SMTP antes de conectar...")
    print(f"[DIAGNOSTICO] SMTP_HOST={SMTP_HOST!r}  SMTP_PORT={SMTP_PORT}")
    print(f"[DIAGNOSTICO] len(SMTP_USER)={len(SMTP_USER)}  len(SMTP_PASSWORD)={len(SMTP_PASSWORD)}")
    _resumen_caracteres_sospechosos("SMTP_USER", SMTP_USER)
    _resumen_caracteres_sospechosos("SMTP_PASSWORD", SMTP_PASSWORD)
    _resumen_caracteres_sospechosos("SMTP_FROM", SMTP_FROM)

    numero = odf.get("numero", "SIN-NUMERO")
    empresa = (odf.get("cliente") or {}).get("empresa", "SIN-EMPRESA")
    asunto = f"ODF VCP ELECTRIC - {numero} - {empresa}"
    cuerpo_texto = construir_cuerpo_correo(odf)
    _resumen_caracteres_sospechosos("Asunto del correo", asunto)
    _resumen_caracteres_sospechosos("Cuerpo del correo", cuerpo_texto)

    # EmailMessage (policy moderna) codifica automaticamente headers y cuerpo no-ASCII
    # en MIME/UTF-8 al serializar, evitando el .encode('ascii') interno de smtplib.
    mensaje = EmailMessage()
    mensaje["Subject"] = asunto
    mensaje["From"] = SMTP_FROM
    mensaje["To"] = DESTINATARIO_PRUEBA
    mensaje["Cc"] = ", ".join(CC_PRUEBA)
    mensaje.set_content(cuerpo_texto, charset="utf-8")

    destinatarios = [DESTINATARIO_PRUEBA, *CC_PRUEBA]

    print(f"[DIAGNOSTICO] Conectando a {SMTP_HOST}:{SMTP_PORT}...")
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as servidor:
        print("[DIAGNOSTICO] Conexion TCP establecida.")
        if SMTP_USE_TLS:
            print("[DIAGNOSTICO] Ejecutando STARTTLS...")
            servidor.starttls()
            print("[DIAGNOSTICO] STARTTLS OK.")
        print("[DIAGNOSTICO] Intentando servidor.login()...")
        servidor.login(SMTP_USER, SMTP_PASSWORD)
        print("[DIAGNOSTICO] Login OK. Intentando servidor.send_message()...")
        servidor.send_message(mensaje, from_addr=SMTP_FROM, to_addrs=destinatarios)
        print("[DIAGNOSTICO] send_message() OK. Correo enviado.")

    return destinatarios


class PortalRequestHandler(SimpleHTTPRequestHandler):
    def _enviar_json(self, status, payload):
        cuerpo = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_POST(self):
        if self.path != "/api/enviar-odf":
            self._enviar_json(404, {"ok": False, "error": "Ruta no encontrada"})
            return

        largo = int(self.headers.get("Content-Length", 0) or 0)
        crudo = self.rfile.read(largo) if largo else b"{}"

        try:
            cuerpo = json.loads(crudo or b"{}")
            odf = cuerpo.get("odf")
            if not odf:
                raise ValueError("El cuerpo debe incluir 'odf'.")

            destinatarios = enviar_correo(odf)
            self._enviar_json(200, {"ok": True, "destinatarios": destinatarios})
        except Exception as error:  # se reporta el mensaje al frontend para depurar
            print("[DIAGNOSTICO] Excepcion al procesar /api/enviar-odf:")
            traceback.print_exc()
            self._enviar_json(400, {"ok": False, "error": str(error)})


def main():
    puerto = int(os.environ.get("PORT", "8000"))
    handler = partial(PortalRequestHandler, directory=str(BASE_DIR))
    with ThreadingHTTPServer(("", puerto), handler) as httpd:
        print(f"Portal B2B disponible en http://localhost:{puerto}/portal.html")
        print("Endpoint de prueba interna: POST /api/enviar-odf")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
