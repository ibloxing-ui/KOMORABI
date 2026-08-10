// client/hwid.js
export function obtenerIDDispositivo() {
    // Modo Desarrollo: asigna un ID único a cada ventana de invitado
    let idPrueba = sessionStorage.getItem('HWID_DEV_TEST');
    if (!idPrueba) {
        idPrueba = 'DEV_HWID_' + Math.random().toString(36).substring(2, 9);
        sessionStorage.setItem('HWID_DEV_TEST', idPrueba);
    }
    return idPrueba;
}