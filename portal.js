const CONFIG = {
	dataFiles: {
		productos: "data/catalogo-b2b.json",
		clientes: "data/clientes.json",
		contactos: "data/contactos-comerciales.json"
	},
	iva: 0.15,
	// Backend local (server.py); nunca credenciales ni destinatarios aquí, solo la ruta.
	apiEnviarOdf: "/api/enviar-odf"
};

// Orden de presentación del acordeón; cualquier grupo/tipo fuera de esta lista se añade al final.
const GRUPOS_ORDEN = ["110V", "220V", "440V", "500V", "ACCESORIOS"];
const TIPOS_ORDEN = ["Toma aérea", "Toma de incrustar", "Toma de sobreponer", "Clavija", "Clavija 45°"];

const state = {
	productos: [],
	catalogoIndice: new Map(), // grupo -> Map(tipo -> productos[])
	gruposOrden: [],
	clientes: [],
	contactos: [],
	clientesPorIdentificador: new Map(), // RUC/cédula normalizado -> cliente (acceso O(1) para ~33.000 registros)
	cliente: null,
	contacto: null,
	bodega: "",
	catalogoFiltro: "",
	grupoAbierto: "",
	tipoSeleccionado: null, // { grupo, tipo } o null
	carrito: new Map(), // codigo -> cantidad
	ultimoOdf: null
};

const $ = (selector) => document.querySelector(selector);

// Redondeo monetario a 2 decimales (equivalente a ROUND_HALF_UP de Python).
function money(value) {
	return Math.round((Number(value) + 1e-9) * 100) / 100;
}

function formatMoney(value) {
	return `$${money(value).toFixed(2)}`;
}

function formatPercent(value) {
	return `${Math.round(Number(value) * 100)}%`;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function textOrPendiente(value) {
	return value === null || value === undefined || value === "" ? "Pendiente" : String(value);
}

// RUC/cédula se trata como identificador de texto, nunca como número (conserva ceros, ignora espacios/guiones).
function normalizeIdentificador(value) {
	return String(value ?? "").trim().replace(/[\s-]/g, "");
}

function normalizeGoogleDriveImageUrl(value) {
	const source = String(value || "").trim();
	const match = source.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i);
	return match ? `https://lh3.googleusercontent.com/d/${encodeURIComponent(match[1])}=w1200` : source;
}

function driveDownloadUrl(value) {
	const source = String(value || "").trim();
	const match = source.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i);
	return match ? `https://drive.google.com/uc?export=download&id=${match[1]}` : source;
}

async function loadJson(file) {
	const response = await fetch(file, { cache: "no-store" });
	if (!response.ok) throw new Error(`No se pudo cargar ${file}`);
	return response.json();
}

// =========================================================
// CARGA INICIAL
// =========================================================

async function init() {
	try {
		const [productos, clientes, contactos] = await Promise.all([
			loadJson(CONFIG.dataFiles.productos),
			loadJson(CONFIG.dataFiles.clientes),
			loadJson(CONFIG.dataFiles.contactos)
		]);
		state.productos = productos;
		state.clientes = clientes;
		state.contactos = contactos;
		state.clientesPorIdentificador = construirIndiceClientes(clientes);
		construirIndiceCatalogo(productos);
		renderCatalogo();
		bindEvents();
	} catch (error) {
		console.error(error);
		$("#panelCliente").insertAdjacentHTML(
			"beforeend",
			`<p class="panel-note" style="color:var(--red)">No se pudieron cargar los datos del portal. Intenta recargar la página.</p>`
		);
	}
}

// =========================================================
// CLIENTE — IDENTIFICACIÓN POR RUC/CÉDULA
// =========================================================

// Índice O(1) por identificador normalizado: evita cualquier listado/recorrido visual sobre ~33.000 clientes.
function construirIndiceClientes(clientes) {
	const indice = new Map();
	clientes.forEach((cliente) => {
		indice.set(normalizeIdentificador(cliente.ruc), cliente);
	});
	return indice;
}

function buscarContacto(vendedor) {
	return state.contactos.find((contacto) => contacto.vendedor.trim().toUpperCase() === String(vendedor || "").trim().toUpperCase()) || null;
}

function onBuscarClienteSubmit(event) {
	event.preventDefault();
	const identificador = normalizeIdentificador($("#clienteRuc").value);
	const errorEl = $("#clienteError");

	if (!identificador) {
		errorEl.textContent = "Ingrese un RUC/Cédula para buscar.";
		errorEl.classList.remove("is-hidden");
		return;
	}

	const cliente = state.clientesPorIdentificador.get(identificador);
	if (!cliente) {
		state.cliente = null;
		state.contacto = null;
		$("#clienteInfo").classList.add("is-hidden");
		errorEl.textContent = "No encontramos un cliente asociado a este RUC/Cédula. Verifique el número ingresado.";
		errorEl.classList.remove("is-hidden");
		resetBodegaYCarrito();
		return;
	}

	errorEl.classList.add("is-hidden");
	state.cliente = cliente;
	state.contacto = buscarContacto(cliente.vendedor);

	$("#infoEmpresa").textContent = cliente.razonSocial;
	$("#infoRuc").textContent = cliente.ruc;
	$("#infoEmail").textContent = cliente.email;
	$("#infoVendedor").textContent = cliente.vendedor;
	$("#infoDescuento").textContent = formatPercent(cliente.descuentoVTC);
	$("#clienteInfo").classList.remove("is-hidden");
	$("#clienteForm").classList.add("is-hidden");

	// Cliente nuevo: bodega y carrito arrancan limpios (el descuento depende del cliente).
	resetBodegaYCarrito();
}

function onCambiarCliente() {
	state.cliente = null;
	state.contacto = null;
	$("#clienteInfo").classList.add("is-hidden");
	$("#clienteForm").classList.remove("is-hidden");
	$("#clienteError").classList.add("is-hidden");
	$("#clienteRuc").value = "";
	resetBodegaYCarrito();
	$("#clienteRuc").focus();
}

function resetBodegaYCarrito() {
	state.bodega = "";
	state.carrito.clear();
	document.querySelectorAll('input[name="bodega"]').forEach((input) => { input.checked = false; });
	updateBodegaDisponibilidad();
	updateBodegaNota();
	renderCatalogo();
	renderCarrito();
	hideOdf();
}

// =========================================================
// BODEGA
// =========================================================

function onBodegaChange(event) {
	state.bodega = event.target.value;
	updateBodegaNota();
	renderCatalogo();
	renderCarrito();
}

function updateBodegaDisponibilidad() {
	document.querySelectorAll('input[name="bodega"]').forEach((input) => { input.disabled = !state.cliente; });
}

function updateBodegaNota() {
	const nota = $("#bodegaNota");
	if (!state.cliente) {
		nota.textContent = "Identifique su empresa con el RUC/Cédula para habilitar la bodega de despacho.";
	} else if (!state.bodega) {
		nota.textContent = "Selecciona la bodega de despacho para habilitar el catálogo.";
	} else {
		nota.textContent = `Bodega de despacho seleccionada: ${state.bodega === "quito" ? "Quito" : "Guayaquil"}.`;
	}
}

function stockDisponible(producto) {
	if (!state.bodega) return null;
	return state.bodega === "quito" ? Number(producto.stockQuito) : Number(producto.stockGye);
}

function estadoStock(producto, cantidad) {
	const disponible = stockDisponible(producto);
	if (disponible === null) return null;
	if (cantidad <= disponible) {
		return { estado: "DISPONIBLE", disponible, faltante: 0 };
	}
	return { estado: "SUJETO_A_DISPONIBILIDAD", disponible, faltante: cantidad - disponible };
}

// =========================================================
// CATÁLOGO — ÍNDICE POR GRUPO / TIPO (navegación tipo acordeón)
// =========================================================

function etiquetaTipo(producto) {
	return producto.tipoComercial && producto.tipoComercial.trim() ? producto.tipoComercial.trim() : "Sin tipo";
}

function ordenarClaves(claves, orden) {
	const conocidas = orden.filter((clave) => claves.includes(clave));
	const desconocidas = claves.filter((clave) => !orden.includes(clave)).sort();
	return [...conocidas, ...desconocidas];
}

function construirIndiceCatalogo(productos) {
	const indice = new Map();
	productos.forEach((producto) => {
		const grupo = producto.grupo || "SIN_CLASIFICAR";
		const tipo = etiquetaTipo(producto);
		if (!indice.has(grupo)) indice.set(grupo, new Map());
		const tipos = indice.get(grupo);
		if (!tipos.has(tipo)) tipos.set(tipo, []);
		tipos.get(tipo).push(producto);
	});
	state.catalogoIndice = indice;
	state.gruposOrden = ordenarClaves(Array.from(indice.keys()), GRUPOS_ORDEN);
}

function productosFiltrados() {
	const term = state.catalogoFiltro.trim().toLowerCase();
	if (!term) return [];
	return state.productos.filter((producto) =>
		producto.codigo.toLowerCase().includes(term) ||
		producto.descripcion.toLowerCase().includes(term) ||
		producto.referencia.toLowerCase().includes(term) ||
		String(producto.familia || "").toLowerCase().includes(term) ||
		etiquetaTipo(producto).toLowerCase().includes(term)
	);
}

function productoCard(producto) {
	const descuento = state.cliente ? Number(state.cliente.descuentoVTC) : 0;
	const precioLista = money(producto.precioLista);
	const precioNeto = state.cliente ? money(precioLista * (1 - descuento)) : precioLista;
	const image = producto.imagen ? normalizeGoogleDriveImageUrl(producto.imagen) : "";
	const ficha = producto.fichaTecnica ? driveDownloadUrl(producto.fichaTecnica) : "";
	const bodegaLista = Boolean(state.bodega);
	const disponible = stockDisponible(producto);

	let stockMarkup = `<span class="stock-pill na">Seleccione bodega</span>`;
	if (bodegaLista) {
		stockMarkup = `<span class="stock-pill disponible">${disponible} unidades</span>`;
	}

	const disabledAttr = !state.cliente || !bodegaLista ? "disabled" : "";

	return `<article class="producto-card" data-codigo="${escapeHtml(producto.codigo)}">
		<div class="producto-media">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(producto.descripcion)}" loading="lazy" onerror="this.closest('.producto-media').innerHTML='<span class=\\'image-missing\\'>Imagen no disponible</span>'" />` : '<span class="image-missing">Imagen no disponible</span>'}</div>
		<div class="producto-body">
			<p class="producto-code">${escapeHtml(producto.codigo)}</p>
			<p class="producto-desc">${escapeHtml(producto.descripcion)}</p>
			<p class="producto-ref">Referencia: ${escapeHtml(producto.referencia)}</p>
			<div class="precio-row">
				<span class="precio-lista">${formatMoney(precioLista)}</span>
				<span class="precio-neto">${formatMoney(precioNeto)}</span>
			</div>
			${state.cliente ? `<span class="descuento-pill">-${formatPercent(descuento)}</span>` : ""}
			${stockMarkup}
			<div class="producto-actions">
				<input type="number" min="1" value="1" class="cantidad-input" ${disabledAttr} aria-label="Cantidad" />
				<button type="button" class="button button-dark agregar-btn" ${disabledAttr}>Agregar</button>
			</div>
			<a class="link-ficha${ficha ? "" : " disabled"}" href="${ficha || "#"}" ${ficha ? 'target="_blank" rel="noopener"' : 'aria-disabled="true"'}>Ficha técnica</a>
		</div>
	</article>`;
}

function productosGridMarkup(productos) {
	return productos.length
		? `<div class="catalogo-grid">${productos.map(productoCard).join("")}</div>`
		: `<p class="panel-note">No se encontraron productos para esta búsqueda.</p>`;
}

function renderAcordeon() {
	const bloques = state.gruposOrden.map((grupo) => {
		const tipos = state.catalogoIndice.get(grupo);
		const totalGrupo = Array.from(tipos.values()).reduce((acc, lista) => acc + lista.length, 0);
		const abierto = state.grupoAbierto === grupo;
		const tiposOrdenados = ordenarClaves(Array.from(tipos.keys()), TIPOS_ORDEN);

		const chips = tiposOrdenados.map((tipo) => {
			const cantidad = tipos.get(tipo).length;
			return `<button type="button" class="tipo-chip" data-grupo="${escapeHtml(grupo)}" data-tipo="${escapeHtml(tipo)}">${escapeHtml(tipo)} <span class="tipo-count">(${cantidad})</span></button>`;
		}).join("");

		return `<div class="grupo-item${abierto ? " is-open" : ""}">
			<button type="button" class="grupo-header" data-grupo-toggle="${escapeHtml(grupo)}">
				<span class="grupo-nombre">${escapeHtml(grupo)}</span>
				<span class="grupo-meta"><span>${totalGrupo} ${totalGrupo === 1 ? "producto" : "productos"}</span><span class="grupo-caret">▶</span></span>
			</button>
			${abierto ? `<div class="grupo-body">${chips}</div>` : ""}
		</div>`;
	}).join("");

	$("#catalogoGrid").innerHTML = `<div class="catalogo-accordion">${bloques}</div>`;
}

function renderProductosTipo() {
	const { grupo, tipo } = state.tipoSeleccionado;
	const productos = (state.catalogoIndice.get(grupo)?.get(tipo)) || [];
	const breadcrumb = `<div class="catalogo-breadcrumb">
		<button type="button" class="volver-btn" data-volver="catalogo">← Volver</button>
		<span class="breadcrumb-path"><strong>${escapeHtml(grupo)}</strong> / ${escapeHtml(tipo)}</span>
	</div>`;
	$("#catalogoGrid").innerHTML = breadcrumb + productosGridMarkup(productos);
}

function renderResultadosBusqueda() {
	const productos = productosFiltrados();
	const breadcrumb = `<div class="catalogo-breadcrumb">
		<button type="button" class="volver-btn" data-volver="busqueda">× Limpiar búsqueda</button>
		<span class="breadcrumb-path">Resultados para "<strong>${escapeHtml(state.catalogoFiltro.trim())}</strong>"</span>
	</div>`;
	$("#catalogoGrid").innerHTML = breadcrumb + productosGridMarkup(productos);
}

function renderCatalogo() {
	const term = state.catalogoFiltro.trim();
	$("#catalogoCount").textContent = `${state.productos.length} ${state.productos.length === 1 ? "producto" : "productos"}`;

	if (term) {
		renderResultadosBusqueda();
	} else if (state.tipoSeleccionado) {
		renderProductosTipo();
	} else {
		renderAcordeon();
	}
}

function onCatalogoClick(event) {
	const agregarBtn = event.target.closest(".agregar-btn");
	if (agregarBtn) {
		const card = agregarBtn.closest(".producto-card");
		const codigo = card.dataset.codigo;
		const cantidadInput = card.querySelector(".cantidad-input");
		const cantidad = Math.max(1, parseInt(cantidadInput.value, 10) || 1);
		const actual = state.carrito.get(codigo) || 0;
		state.carrito.set(codigo, actual + cantidad);
		renderCarrito();
		return;
	}

	const grupoToggle = event.target.closest("[data-grupo-toggle]");
	if (grupoToggle) {
		const grupo = grupoToggle.dataset.grupoToggle;
		state.grupoAbierto = state.grupoAbierto === grupo ? "" : grupo;
		renderCatalogo();
		return;
	}

	const tipoChip = event.target.closest(".tipo-chip");
	if (tipoChip) {
		state.tipoSeleccionado = { grupo: tipoChip.dataset.grupo, tipo: tipoChip.dataset.tipo };
		renderCatalogo();
		return;
	}

	const volverBtn = event.target.closest("[data-volver]");
	if (volverBtn) {
		if (volverBtn.dataset.volver === "busqueda") {
			state.catalogoFiltro = "";
			$("#catalogoBuscar").value = "";
		}
		state.tipoSeleccionado = null;
		renderCatalogo();
	}
}

// =========================================================
// CARRITO
// =========================================================

function lineasCarrito() {
	const descuento = state.cliente ? Number(state.cliente.descuentoVTC) : 0;
	return Array.from(state.carrito.entries()).map(([codigo, cantidad]) => {
		const producto = state.productos.find((item) => item.codigo === codigo);
		const precioLista = money(producto.precioLista);
		const precioNetoUnitario = money(precioLista * (1 - descuento));
		const precioTotal = money(precioNetoUnitario * cantidad);
		const stockInfo = estadoStock(producto, cantidad);
		return { producto, cantidad, descuento, precioLista, precioNetoUnitario, precioTotal, stockInfo };
	});
}

function totalesCarrito(lineas) {
	const subtotal = money(lineas.reduce((acc, linea) => acc + linea.precioTotal, 0));
	const iva = money(subtotal * CONFIG.iva);
	const total = money(subtotal + iva);
	return { subtotal, iva, total };
}

function renderCarrito() {
	const lineas = lineasCarrito();
	const vacio = $("#carritoVacio");
	const tableWrap = $("#carritoTableWrap");
	$("#carritoCount").textContent = `${lineas.length} ${lineas.length === 1 ? "item" : "items"}`;

	if (!lineas.length) {
		vacio.classList.remove("is-hidden");
		tableWrap.classList.add("is-hidden");
	} else {
		vacio.classList.add("is-hidden");
		tableWrap.classList.remove("is-hidden");
		$("#carritoBody").innerHTML = lineas.map((linea) => {
			const stock = linea.stockInfo;
			const stockMarkup = stock
				? stock.estado === "DISPONIBLE"
					? `<span class="stock-pill disponible">DISPONIBLE</span>`
					: `<span class="stock-pill sujeto">SUJETO A DISPONIBILIDAD<br>Faltante: ${stock.faltante}</span>`
				: `<span class="stock-pill na">Sin bodega</span>`;
			return `<tr data-codigo="${escapeHtml(linea.producto.codigo)}">
				<td>${escapeHtml(linea.producto.codigo)}</td>
				<td>${escapeHtml(linea.producto.descripcion)}</td>
				<td>${formatMoney(linea.precioLista)}</td>
				<td>${formatPercent(linea.descuento)}</td>
				<td>${formatMoney(linea.precioNetoUnitario)}</td>
				<td>
					<div class="qty-controls">
						<button type="button" class="qty-dec" aria-label="Disminuir">−</button>
						<span>${linea.cantidad}</span>
						<button type="button" class="qty-inc" aria-label="Aumentar">+</button>
					</div>
				</td>
				<td>${formatMoney(linea.precioTotal)}</td>
				<td>${stockMarkup}</td>
				<td><button type="button" class="remove-btn">Eliminar</button></td>
			</tr>`;
		}).join("");
	}

	const { subtotal, iva, total } = totalesCarrito(lineas);
	$("#resSubtotal").textContent = formatMoney(subtotal);
	$("#resIva").textContent = formatMoney(iva);
	$("#resTotal").textContent = formatMoney(total);
	$("#generarOdfBtn").disabled = !(state.cliente && state.bodega && lineas.length);
}

function onCarritoClick(event) {
	const row = event.target.closest("tr[data-codigo]");
	if (!row) return;
	const codigo = row.dataset.codigo;
	const actual = state.carrito.get(codigo) || 0;

	if (event.target.closest(".qty-inc")) {
		state.carrito.set(codigo, actual + 1);
	} else if (event.target.closest(".qty-dec")) {
		if (actual > 1) state.carrito.set(codigo, actual - 1);
		else state.carrito.delete(codigo);
	} else if (event.target.closest(".remove-btn")) {
		state.carrito.delete(codigo);
	} else {
		return;
	}
	renderCarrito();
}

// =========================================================
// ODF
// =========================================================

function generarNumeroOdf() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	const fecha = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const hora = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `ODF-VCP-${fecha}-${hora}`;
}

function construirOdf() {
	const lineas = lineasCarrito();
	const { subtotal, iva, total } = totalesCarrito(lineas);
	const cliente = state.cliente;
	const contacto = state.contacto;
	const now = new Date();

	const detalle = lineas.map((linea, index) => ({
		item: index + 1,
		codigo: linea.producto.codigo,
		descripcion: linea.producto.descripcion,
		referencia: linea.producto.referencia,
		cantidad: linea.cantidad,
		descuentoPorcentaje: formatPercent(linea.descuento),
		precioLista: linea.precioLista,
		precioNetoUnitario: linea.precioNetoUnitario,
		precioTotal: linea.precioTotal,
		bodega: state.bodega === "quito" ? "Quito" : "Guayaquil",
		stockDisponible: linea.stockInfo.disponible,
		estadoStock: linea.stockInfo.estado,
		transito: linea.producto.transito
	}));

	return {
		tipoDocumento: "ORDEN DE FACTURACIÓN (ODF)",
		numero: generarNumeroOdf(),
		fecha: now.toLocaleString("es-EC"),
		marca: "VCP ELECTRIC",
		cliente: {
			empresa: cliente.razonSocial,
			ruc: cliente.ruc,
			email: cliente.email,
			ciudad: null,
			direccion: null,
			telefono: null,
			cartera: null,
			formaPago: null
		},
		comercial: {
			responsable: cliente.vendedor,
			descuentoVTC: cliente.descuentoVTC,
			descuentoPorcentaje: formatPercent(cliente.descuentoVTC)
		},
		destinatarios: {
			cliente: { nombre: cliente.razonSocial, email: cliente.email },
			vendedor: { nombre: contacto ? contacto.vendedor : cliente.vendedor, email: contacto ? contacto.emailVendedor : "" },
			gerente: { nombre: contacto ? contacto.gerente : "", email: contacto ? contacto.emailGerente : "" },
			servicioCliente: { nombre: contacto ? contacto.servicioCliente : "", email: contacto ? contacto.emailServicioCliente : "" }
		},
		detalle,
		resumen: { subtotal, ivaPorcentaje: CONFIG.iva, iva, total },
		condicionesComerciales: {
			precios: "Netos en dólares",
			iva: "15%",
			tiempoEntrega: "Sujeto a disponibilidad"
		},
		estado: "BORRADOR_NO_ENVIADO"
	};
}

function renderOdf(odf) {
	const fila = (linea) => `<tr>
		<td>${linea.item}</td>
		<td>${escapeHtml(linea.codigo)}</td>
		<td>${escapeHtml(linea.descripcion)}</td>
		<td>${escapeHtml(linea.referencia)}</td>
		<td>${linea.cantidad}</td>
		<td>${linea.descuentoPorcentaje}</td>
		<td>${formatMoney(linea.precioNetoUnitario)}</td>
		<td>${formatMoney(linea.precioTotal)}</td>
	</tr>`;

	const filaStock = (linea) => `<tr>
		<td>${escapeHtml(linea.bodega)}</td>
		<td>${linea.stockDisponible}</td>
		<td>${linea.estadoStock === "DISPONIBLE" ? "DISPONIBLE" : "SUJETO A DISPONIBILIDAD"}</td>
	</tr>`;

	$("#odfContent").innerHTML = `<div class="odf-doc">
		<p class="odf-marca">${escapeHtml(odf.marca)}</p>
		<h3>${escapeHtml(odf.tipoDocumento)}</h3>
		<div class="odf-meta"><span>N° ${escapeHtml(odf.numero)}</span><span>${escapeHtml(odf.fecha)}</span></div>

		<section>
			<h4>Datos del cliente</h4>
			<div class="odf-grid">
				<div><span>Empresa</span><strong>${escapeHtml(odf.cliente.empresa)}</strong></div>
				<div><span>RUC</span><strong>${escapeHtml(odf.cliente.ruc)}</strong></div>
				<div><span>E-mail</span><strong>${escapeHtml(odf.cliente.email)}</strong></div>
				<div><span>Vendedor / Responsable</span><strong>${escapeHtml(odf.comercial.responsable)}</strong></div>
				<div><span>Descuento VTC</span><strong>${odf.comercial.descuentoPorcentaje}</strong></div>
				<div><span>Ciudad</span><strong>${textOrPendiente(odf.cliente.ciudad)}</strong></div>
				<div><span>Dirección</span><strong>${textOrPendiente(odf.cliente.direccion)}</strong></div>
				<div><span>Teléfono</span><strong>${textOrPendiente(odf.cliente.telefono)}</strong></div>
				<div><span>Cartera</span><strong>${textOrPendiente(odf.cliente.cartera)}</strong></div>
				<div><span>Forma de pago</span><strong>${textOrPendiente(odf.cliente.formaPago)}</strong></div>
			</div>
		</section>

		<section>
			<h4>Detalle del pedido</h4>
			<table class="odf-table">
				<thead><tr><th>Item</th><th>Código</th><th>Descripción</th><th>Referencia</th><th>Cant.</th><th>Dscto %</th><th>PU Desc</th><th>Precio Total</th></tr></thead>
				<tbody>${odf.detalle.map(fila).join("")}</tbody>
			</table>
		</section>

		<section>
			<h4>Stock</h4>
			<table class="odf-table">
				<thead><tr><th>Bodega</th><th>Stock disponible</th><th>Estado</th></tr></thead>
				<tbody>${odf.detalle.map(filaStock).join("")}</tbody>
			</table>
		</section>

		<section>
			<h4>Resumen</h4>
			<div class="odf-resumen">
				<div><span>Subtotal</span><strong>${formatMoney(odf.resumen.subtotal)}</strong></div>
				<div><span>IVA 15%</span><strong>${formatMoney(odf.resumen.iva)}</strong></div>
				<div><span>Total</span><strong>${formatMoney(odf.resumen.total)}</strong></div>
			</div>
		</section>

		<section>
			<h4>Condiciones</h4>
			<p>PRECIOS: ${escapeHtml(odf.condicionesComerciales.precios.toUpperCase())}</p>
			<p>IVA: ${escapeHtml(odf.condicionesComerciales.iva)}</p>
			<p>TIEMPO DE ENTREGA: ${escapeHtml(odf.condicionesComerciales.tiempoEntrega.toUpperCase())}</p>
		</section>

		<section class="odf-destinatarios">
			<h4>Destinatarios (no se envía correo en esta fase)</h4>
			<div><strong>PARA:</strong> ${escapeHtml(odf.destinatarios.cliente.email)}</div>
			<div><strong>CC:</strong> ${escapeHtml(odf.destinatarios.vendedor.email)}, ${escapeHtml(odf.destinatarios.gerente.email)}, ${escapeHtml(odf.destinatarios.servicioCliente.email)}</div>
		</section>
	</div>`;

	$("#panelOdf").classList.remove("is-hidden");
	$("#panelOdf").scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideOdf() {
	$("#panelOdf").classList.add("is-hidden");
	$("#odfContent").innerHTML = "";
	state.ultimoOdf = null;
	setEnviarOdfStatus("");
}

function onGenerarOdf() {
	if (!state.cliente || !state.bodega || !state.carrito.size) return;
	const odf = construirOdf();
	state.ultimoOdf = odf;
	setEnviarOdfStatus("");
	renderOdf(odf);
}

// =========================================================
// ENVÍO DE PRUEBA (SOLO INTERNO) — el correo del cliente se ignora siempre
// =========================================================

function setEnviarOdfStatus(message, tipo) {
	const el = $("#enviarOdfStatus");
	el.textContent = message;
	el.classList.remove("is-success", "is-error");
	if (message && tipo) el.classList.add(tipo === "ok" ? "is-success" : "is-error");
	el.classList.toggle("is-hidden", !message);
}

async function onEnviarOdf() {
	if (!state.ultimoOdf) return;
	const boton = $("#enviarOdfBtn");
	boton.disabled = true;
	setEnviarOdfStatus("Enviando correo de prueba interna…");

	try {
		const response = await fetch(CONFIG.apiEnviarOdf, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ odf: state.ultimoOdf })
		});
		const data = await response.json().catch(() => ({}));

		if (!response.ok || !data.ok) {
			throw new Error(data.error || "No se pudo enviar el correo.");
		}

		setEnviarOdfStatus(
			`Correo de prueba enviado a: ${data.destinatarios.join(", ")}. El cliente no fue incluido.`,
			"ok"
		);
	} catch (error) {
		setEnviarOdfStatus(`No se pudo enviar el correo: ${error.message}`, "error");
	} finally {
		boton.disabled = false;
	}
}

// =========================================================
// EVENTOS
// =========================================================

function bindEvents() {
	$("#clienteForm").addEventListener("submit", onBuscarClienteSubmit);
	$("#cambiarClienteBtn").addEventListener("click", onCambiarCliente);
	document.querySelectorAll('input[name="bodega"]').forEach((input) => input.addEventListener("change", onBodegaChange));
	$("#catalogoBuscar").addEventListener("input", (event) => {
		state.catalogoFiltro = event.target.value;
		renderCatalogo();
	});
	$("#catalogoGrid").addEventListener("click", onCatalogoClick);
	$("#carritoBody").addEventListener("click", onCarritoClick);
	$("#generarOdfBtn").addEventListener("click", onGenerarOdf);
	$("#imprimirOdfBtn").addEventListener("click", () => window.print());
	$("#enviarOdfBtn").addEventListener("click", onEnviarOdf);
}

document.addEventListener("DOMContentLoaded", init);
