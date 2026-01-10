#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <rpc.h>
#include "Interface_h.h"

void __RPC_FAR * __RPC_USER midl_user_allocate(size_t len) {
    return malloc(len);
}

void __RPC_USER midl_user_free(void __RPC_FAR * ptr) {
    free(ptr);
}

void print_usage(const char* program_name) {
    printf("Usage: %s <server_ip> <port>\n", program_name);
    printf("Example: %s 192.168.1.31 50001\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status;
    RPC_WSTR stringBinding = NULL;
    handle_t hBinding = NULL;
    wchar_t server_ip[256];
    wchar_t port[16];
    
    if (argc != 3) {
        print_usage(argv[0]);
        return 1;
    }
    
    MultiByteToWideChar(CP_ACP, 0, argv[1], -1, server_ip, 256);
    MultiByteToWideChar(CP_ACP, 0, argv[2], -1, port, 16);
    
    printf("Connecting to server %s:%s...\n", argv[1], argv[2]);
    
    // Create the binding string
    status = RpcStringBindingCompose(
        NULL,
        (RPC_WSTR)L"ncacn_ip_tcp",
        server_ip,
        port,
        NULL,
        &stringBinding
    );
    
    if (status != RPC_S_OK) {
        printf("Error RpcStringBindingCompose: 0x%x\n", status);
        return 1;
    }
    
    // Create the binding handle
    status = RpcBindingFromStringBinding(
        stringBinding,
        &hBinding
    );
    
    RpcStringFree(&stringBinding);
    
    if (status != RPC_S_OK) {
        printf("Error RpcBindingFromStringBinding: 0x%x\n", status);
        return 1;
    }
    
    // Explicitly disable authentication
    status = RpcBindingSetAuthInfo(
        hBinding,
        NULL,
        RPC_C_AUTHN_LEVEL_NONE,  // No authentication
        RPC_C_AUTHN_NONE,  // No authentication service
        NULL,
        RPC_C_AUTHZ_NONE  // No authorization
    );
    
    if (status != RPC_S_OK) {
        printf("Warning: RpcBindingSetAuthInfo failed: 0x%x (continuing anyway)\n", status);
    }
    
    printf("Connection successful!\n");
    
    // Call RPC function
    RpcTryExcept {
        int param1 = 42;
        int outNumber = 0;
        
        printf("Calling MyRemoteProc(42)...\n");
        MyRemoteProc(hBinding, param1, &outNumber);
        printf("Result: outNumber = %d\n", outNumber);
    }
    RpcExcept(1) {
        unsigned long exception = RpcExceptionCode();
        printf("RPC Exception: 0x%x\n", exception);
        
        switch (exception) {
            case RPC_S_SERVER_UNAVAILABLE:
            case 0x6ba:
                printf("Server unavailable - Make sure server is running!\n");
                break;
            case RPC_S_ACCESS_DENIED:
            case 0x5:
                printf("Access denied - Authentication issue\n");
                break;
            case RPC_S_CALL_FAILED:
                printf("Call failed\n");
                break;
            case RPC_S_COMM_FAILURE:
                printf("Communication failure\n");
                break;
            default:
                printf("Unknown RPC error\n");
        }
    }
    RpcEndExcept
    
    // Free the binding
    status = RpcBindingFree(&hBinding);
    if (status != RPC_S_OK) {
        printf("Error RpcBindingFree: 0x%x\n", status);
    }
    
    printf("Disconnection successful.\n");
    return 0;
}
