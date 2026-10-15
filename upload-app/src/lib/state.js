export let receiptsData = [];
export let claimsData = [];
export let claimsDataBackend = '';
export let claimsLoadErrorMessage = '';

export function setReceiptsData(data) {
  receiptsData = data;
}

export function setClaimsData(data, backend = '') {
  claimsData = data;
  claimsDataBackend = backend;
}

export function setClaimsLoadErrorMessage(message) {
  claimsLoadErrorMessage = message;
}
