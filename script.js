const CONFIG = {
	dataFiles: {
		products: "productos.json",
		decisionMatrix: "matrizDecision.json"
	},
	// Replace this placeholder with the official VCP sales number before publishing.
	whatsappNumber: "",
	fields: ["tipo", "amperaje", "configuracion", "ip", "voltaje"]
};

const state = {
	products: [],
	matrix: null,
	selections: Object.fromEntries(CONFIG.fields.map((field) => [field, ""])),
	searchResults: null
};

const $ = (selector) => document.querySelector(selector);

function normalize(value) {
	return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function textOrDash(value) {
	return value === null || value === undefined || value === "" ? "-" : String(value);
}

function driveUrl(value, mode = "view") {
	const source = String(value || "");
	const match = source.match(/drive\.google\.com\/file\/d\/([^/]+)/i);
	return match ? `https://drive.google.com/uc?export=${mode}&id=${match[1]}` : source;
}

function normalizeGoogleDriveImageUrl(value) {
	const source = String(value || "").trim();
	const match = source.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i);
	return match ? `https://lh3.googleusercontent.com/d/${encodeURIComponent(match[1])}=w1200` : source;
}

function handleImageError(imageElement) {
	const media = imageElement.closest(".product-media");
	if (!media) return;
	imageElement.remove();
	const fallback = document.createElement("span");
	fallback.className = "image-missing";
	fallback.textContent = "Imagen no disponible";
	media.appendChild(fallback);
}

async function loadJson(file) {
	const response = await fetch(file, { cache: "no-store" });
	if (!response.ok) throw new Error(`No se pudo cargar ${file}`);
	return response.json();
}

function setStatus(message = "") { $("#statusMessage").textContent = message; }

function setSelectOptions(select, values, placeholder) {
	select.innerHTML = [
		`<option value="">${escapeHtml(placeholder)}</option>`,
		...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
	].join("");
}

function prefixKey(depth) { return CONFIG.fields.slice(0, depth).map((field) => state.selections[field]).join("|"); }

function availableOptions(depth) {
	if (depth === 0) return state.matrix.opcionesIniciales || [];
	const dependencyKey = CONFIG.fields.slice(0, depth).join("|");
	return state.matrix.opcionesDependientes[dependencyKey]?.[prefixKey(depth)] || [];
}

function updateProgress() {
	const complete = CONFIG.fields.filter((field) => state.selections[field]).length;
	$("#progressLabel").textContent = `${complete} / ${CONFIG.fields.length}`;
	$("#progressBar").style.width = `${complete * 20}%`;
}

function clearResults(message = "Completa los cinco filtros para consultar productos compatibles.") {
	$("#resultsCount").textContent = "0 opciones";
	$("#resultsSummary").textContent = message;
	$("#resultsGrid").innerHTML = `<div class="empty-state"><div><strong>Tu selección aparecerá aquí</strong><span>Usa los filtros técnicos o busca un código VCP.</span></div></div>`;
}

function renderOptions() {
	CONFIG.fields.forEach((field, depth) => {
		const select = $(`#${field}`);
		const options = availableOptions(depth);
		const current = state.selections[field];
		setSelectOptions(select, options, depth === 0 ? "Selecciona un tipo" : `Selecciona ${field}`);
		select.disabled = depth > 0 && !state.selections[CONFIG.fields[depth - 1]];
		if (current && options.includes(current)) select.value = current;
	});
	updateProgress();
}

function currentProducts() {
	if (CONFIG.fields.some((field) => !state.selections[field])) return [];
	const combination = state.matrix.combinaciones.find((record) => CONFIG.fields.every((field) => record[field] === state.selections[field]));
	return combination ? combination.productos.map((code) => state.products.find((product) => product.codigo === code)).filter(Boolean) : [];
}

function whatsappUrl(product) {
	if (!CONFIG.whatsappNumber) return "";
	const message = `Hola, necesito cotizar el producto VCP.%0ACódigo: ${encodeURIComponent(product.codigo)}%0AReferencia: ${encodeURIComponent(product.referencia)}%0ADescripción: ${encodeURIComponent(product.descripcion)}`;
	return `https://wa.me/${CONFIG.whatsappNumber}?text=${message}`;
}

function productCard(product, multiple) {
	const image = product.imagen ? normalizeGoogleDriveImageUrl(product.imagen) : "";
	const ficha = product.fichaTecnica ? driveUrl(product.fichaTecnica, "download") : "";
	const whatsapp = whatsappUrl(product);
	const whatsappMarkup = whatsapp
		? `<a class="link-whatsapp" href="${whatsapp}" target="_blank" rel="noopener">Solicitar cotización</a>`
		: `<a class="link-whatsapp" href="#" aria-disabled="true" data-whatsapp-placeholder>Solicitar cotización</a>`;
	return `<article class="product-card">
		<div class="product-media">${multiple ? '<span class="compatibility-badge">Producto compatible</span>' : ""}${image ? `<img class="product-image" src="${escapeHtml(image)}" alt="${escapeHtml(product.descripcion)}" loading="lazy" />` : '<span class="image-missing">Imagen no disponible</span>'}</div>
		<div class="product-body">
			<p class="product-code">${escapeHtml(product.codigo)}</p>
			<h3>${escapeHtml(product.tipo)}</h3>
			<p class="product-reference">Referencia: <strong>${escapeHtml(product.referencia)}</strong></p>
			<p class="product-description">${escapeHtml(product.descripcion)}</p>
			<dl class="spec-list">
				<div><dt>Amperaje</dt><dd>${escapeHtml(textOrDash(product.amperaje))}</dd></div>
				<div><dt>Configuración</dt><dd>${escapeHtml(textOrDash(product.configuracion))}</dd></div>
				<div><dt>Protección</dt><dd>${escapeHtml(textOrDash(product.ip))}</dd></div>
				<div><dt>Voltaje</dt><dd>${escapeHtml(textOrDash(product.voltaje))}</dd></div>
			</dl>
			<div class="product-price"><small>PVP</small><strong>$${Number(product.pvp).toFixed(2)}</strong></div>
			<div class="card-actions"><a class="link-ficha${ficha ? "" : " disabled"}" href="${ficha || "#"}" ${ficha ? 'target="_blank" rel="noopener"' : 'aria-disabled="true"'}>Ficha técnica</a>${whatsappMarkup}</div>
		</div>
	</article>`;
}

function renderProducts(products, summary, title = "Productos compatibles") {
	$("#resultsTitle").textContent = title;
	$("#resultsCount").textContent = `${products.length} ${products.length === 1 ? "opción" : "opciones"}`;
	$("#resultsSummary").textContent = summary;
	$("#resultsGrid").innerHTML = products.length
		? products.map((product) => productCard(product, products.length > 1)).join("")
		: `<div class="empty-state"><div><strong>No encontramos coincidencias</strong><span>Prueba con otra selección o revisa el código VCP.</span></div></div>`;
	$("#resultsGrid").querySelectorAll(".product-image").forEach((image) => {
		image.addEventListener("error", () => handleImageError(image), { once: true });
	});
}

function renderSelectionResults() {
	state.searchResults = null;
	setStatus("");
	const selectedCount = CONFIG.fields.filter((field) => state.selections[field]).length;
	if (selectedCount < CONFIG.fields.length) {
		clearResults(selectedCount ? "Continúa con el siguiente filtro disponible." : undefined);
		return;
	}
	const products = currentProducts();
	const summary = `${CONFIG.fields.map((field) => state.selections[field]).join(" · ")} · ${products.length} resultado${products.length === 1 ? "" : "s"}`;
	renderProducts(products, summary);
}

function handleFilterChange(event) {
	const field = event.target.dataset.filter;
	const depth = CONFIG.fields.indexOf(field);
	state.selections[field] = event.target.value;
	CONFIG.fields.slice(depth + 1).forEach((laterField) => { state.selections[laterField] = ""; });
	renderOptions();
	renderSelectionResults();
}

function searchByCode() {
	const query = normalize($("#codeSearch").value).replace(/\s/g, "");
	if (!query) { clearResults(); setStatus(""); return; }
	const products = state.products.filter((product) => normalize(product.codigo).replace(/\s/g, "") === query);
	if (products.length) {
		setStatus("");
		renderProducts(products, `Coincidencia directa para el código ${products[0].codigo}.`, "Búsqueda por código");
	} else {
		setStatus("No encontramos un producto con ese código VCP.");
		renderProducts([], "Verifica el código e inténtalo de nuevo.", "Búsqueda por código");
	}
}

function resetSelector() {
	state.selections = Object.fromEntries(CONFIG.fields.map((field) => [field, ""]));
	$("#codeSearch").value = "";
	renderOptions();
	setStatus("");
	$("#resultsTitle").textContent = "Productos compatibles";
	clearResults();
}

async function init() {
	try {
		const [products, matrix] = await Promise.all([loadJson(CONFIG.dataFiles.products), loadJson(CONFIG.dataFiles.decisionMatrix)]);
		state.products = Array.isArray(products) ? products : [];
		state.matrix = matrix;
		renderOptions();
		clearResults();
		$("#selectorForm").addEventListener("change", handleFilterChange);
		$("#searchButton").addEventListener("click", searchByCode);
		$("#codeSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") searchByCode(); });
		$("#resetButton").addEventListener("click", resetSelector);
		$("#resultsGrid").addEventListener("click", (event) => {
			if (event.target.matches("[data-whatsapp-placeholder]")) {
				event.preventDefault();
				setStatus("Configura el número comercial de WhatsApp en script.js para habilitar las cotizaciones.");
			}
		});
	} catch (error) {
		setStatus(error.message || "No se pudieron cargar los datos del selector.");
		$("#resultsGrid").innerHTML = `<div class="empty-state"><div><strong>Error de carga</strong><span>Revisa que productos.json y matrizDecision.json estén disponibles.</span></div></div>`;
	}
}

document.addEventListener("DOMContentLoaded", init);
