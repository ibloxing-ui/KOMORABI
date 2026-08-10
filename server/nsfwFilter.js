// server/nsfwFilter.js

/**
 * Filtro de imágenes en servidor
 * @param {string} contenidoImagen - String en Base64 o URL de la imagen
 * @returns {Promise<boolean>} - Devuelve true si la imagen es flaggeada como NSFW
 */
async function detectarContenidoNSFW(contenidoImagen) {
    // 1. MODO DESARROLLO / PRUEBAS RÁPIDAS
    // Si la imagen incluye el texto "test_nsfw" en su nombre o Base64, la detecta como sensible
    if (process.env.NODE_ENV === 'development') {
        if (typeof contenidoImagen === 'string' && contenidoImagen.includes('test_nsfw')) {
            console.log('\x1b[33m[NSFW FILTER] Imagen de prueba detectada como SENSIBLE.\x1b[0m');
            return true;
        }
        return false;
    }

    // 2. MODO PRODUCCIÓN (Integración futura con nsfwjs o API externa)
    try {
        // Ejemplo de estructura para cuando conectes un modelo local (TensorFlow / nsfwjs):
        // const predictions = await nsfwModel.classify(imageBuffer);
        // return predictions.some(p => p.className === 'Porn' && p.probability > 0.7);
        return false;
    } catch (error) {
        console.error('[NSFW FILTER ERROR]:', error);
        return false; // Ante la duda o error de red, no banea por accidente
    }
}

module.exports = { detectarContenidoNSFW };