#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include "Interface_h.h"

void __RPC_FAR* __RPC_USER midl_user_allocate(size_t len) {
    return malloc(len);
}

void __RPC_USER midl_user_free(void __RPC_FAR* ptr) {
    free(ptr);
}

void print_usage(const char* program_name) {
    printf("Usage: %s <port>\n", program_name);
    printf("Example: %s 50001\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status;
    wchar_t port[16];
    
    // Check command line arguments
    if (argc != 2) {
        print_usage(argv[0]);
        return 1;
    }
    
    // Convert port argument to wchar_t
    MultiByteToWideChar(CP_ACP, 0, argv[1], -1, port, 16);
    
    printf("Starting RPC server on port %s...\n", argv[1]);
    
    // Create a security descriptor that allows everyone (disable security)
    SECURITY_DESCRIPTOR sd;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE);  // NULL DACL = everyone allowed
    
    // Use TCP/IP with specified port
    status = RpcServerUseProtseqEp(
        (RPC_WSTR)L"ncacn_ip_tcp",
        RPC_C_PROTSEQ_MAX_REQS_DEFAULT,
        port,
        &sd  // Security descriptor (allows everyone)
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerUseProtseqEp: 0x%x (%d)\n", status, status);
        return 1;
    }
    
    printf("RPC TCP server listening on port %s...\n", argv[1]);
    
    // Register the interface
    status = RpcServerRegisterIf(
        MyInterface_v1_0_s_ifspec,
        NULL,
        NULL
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerRegisterIf: 0x%x (%d)\n", status, status);
        return 1;
    }
    
    printf("Interface registered successfully!\n");
    printf("Server is ready and waiting for connections...\n");
    
    // Start listening (blocking call)
    status = RpcServerListen(
        1,
        RPC_C_LISTEN_MAX_CALLS_DEFAULT,
        FALSE  // Blocking mode
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerListen: 0x%x (%d)\n", status, status);
        return 1;
    }
    
    printf("Server stopped.\n");
    return 0;
}
