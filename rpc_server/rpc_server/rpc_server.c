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
    
    if (argc != 2) {
        print_usage(argv[0]);
        return 1;
    }
    
    MultiByteToWideChar(CP_ACP, 0, argv[1], -1, port, 16);
    
    printf("Starting RPC server on port %s...\n", argv[1]);
    
    // Create security descriptor that allows everyone
    SECURITY_DESCRIPTOR sd;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE);
    
    // Use TCP/IP with specified port
    status = RpcServerUseProtseqEp(
        (RPC_WSTR)L"ncacn_ip_tcp",
        RPC_C_PROTSEQ_MAX_REQS_DEFAULT,
        port,
        &sd
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerUseProtseqEp: 0x%x (%d)\n", status, status);
        return 1;
    }
    
    printf("Protocol sequence registered on port %s\n", argv[1]);
    
    // Register interface without authentication
    status = RpcServerRegisterIf2(
        MyInterface_v1_0_s_ifspec,
        NULL,
        NULL,
        RPC_IF_ALLOW_CALLBACKS_WITH_NO_AUTH,  // Allow calls without auth
        RPC_C_LISTEN_MAX_CALLS_DEFAULT,
        (unsigned int)-1,
        NULL
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerRegisterIf2: 0x%x (%d)\n", status, status);
        return 1;
    }
    
    printf("Interface registered successfully!\n");
    
    // Disable authentication requirements completely
    status = RpcServerRegisterAuthInfo(
        NULL,
        RPC_C_AUTHN_NONE,
        NULL,
        NULL
    );
    
    if (status != RPC_S_OK && status != RPC_S_UNKNOWN_AUTHN_SERVICE) {
        printf("Warning: RpcServerRegisterAuthInfo: 0x%x\n", status);
    }
    
    printf("Server is ready and waiting for connections...\n");
    printf("Press Ctrl+C to stop.\n");
    
    // Start listening
    status = RpcServerListen(
        1,
        RPC_C_LISTEN_MAX_CALLS_DEFAULT,
        FALSE
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcServerListen: 0x%x (%d)\n", status, status);
        return 1;
    }
    
    printf("Server stopped.\n");
    return 0;
}
