#include <Windows.h>
#include <stdio.h>

#include "Interface_h.h"

int main() {
	RPC_STATUS status;
	status = RpcServerUseProtseqEp(
		(RPC_WSTR)L"ncacn_ip_tcp",
		RPC_C_PROTSEQ_MAX_REQS_DEFAULT,
		(RPC_WSTR)L"50001",
		NULL
	);
	if (status != RPC_S_OK) {
		printf("Erreur RpcServerUseProtsecEp 0x%x (%d)", status, status);
		return -1;
	}
	status = RpcServerRegisterIf(
		MyInterface_v1_0_s_ifspec,
		NULL,
		NULL
	);
	if (status != RPC_S_OK) {
		printf("Erreur RpcServerRegisterIf");
		return -1;
	}
	status = RpcServerListen(1, RPC_C_LISTEN_MAX_CALLS_DEFAULT, FALSE);
	if (status != RPC_S_OK) {
		printf("Erreur RpcServerListen");
		return -1;
	}
	printf("Interface registered !");
	return 0;
}

void __RPC_FAR* __RPC_USER midl_user_allocate(size_t len) {
	return malloc(len);
}
void __RPC_USER midl_user_free(void __RPC_FAR* ptr) {
	free(ptr);
}