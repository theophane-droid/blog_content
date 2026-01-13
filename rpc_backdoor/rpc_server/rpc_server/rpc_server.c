// rpc_server.c
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <rpc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "Interface_h.h"

#pragma comment(lib, "Rpcrt4.lib")

void* __RPC_USER midl_user_allocate(size_t len) { return malloc(len); }
void  __RPC_USER midl_user_free(void* ptr) { free(ptr); }

static void print_usage(const char* program_name) {
    printf("Usage: %s [-e] <port>\n", program_name);
    printf("\nOptions:\n");
    printf("  -e           Use endpoint mapper (dynamic port allocation)\n");
    printf("  <port>       Specific port to bind (without -e)\n");
    printf("\nExamples:\n");
    printf("  %s 50001           - Bind to specific port 50001\n", program_name);
    printf("  %s -e              - Use endpoint mapper (dynamic port)\n", program_name);
}

int main(int argc, char* argv[]) {
    RPC_STATUS status = RPC_S_OK;
    BOOL use_endpoint_mapper = FALSE;
    wchar_t port[16] = { 0 };
    const char* port_arg = NULL;

    RPC_BINDING_VECTOR* binding_vector = NULL;
    BOOL ep_registered = FALSE;

    // Parse args
    if (argc < 2 || argc > 3) {
        print_usage(argv[0]);
        return 1;
    }

    if (strcmp(argv[1], "-e") == 0) {
        use_endpoint_mapper = TRUE;
        if (argc == 3) {
            // NOTE: for -e we ignore the port value (dynamic port anyway)
            // keep it only if you want to use it for something else
            port_arg = argv[2];
        }
    } else {
        if (argc != 2) {
            print_usage(argv[0]);
            return 1;
        }
        port_arg = argv[1];
        MultiByteToWideChar(CP_ACP, 0, port_arg, -1, port, (int)_countof(port));
    }

    // Security (NULL DACL => everyone full access). OK for tests only.
    SECURITY_DESCRIPTOR sd;
    if (!InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION)) {
        printf("InitializeSecurityDescriptor failed: %lu\n", GetLastError());
        return 1;
    }
    if (!SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE)) {
        printf("SetSecurityDescriptorDacl failed: %lu\n", GetLastError());
        return 1;
    }

    // Register protocol sequence / endpoint
    if (use_endpoint_mapper) {
        printf("Starting RPC server with endpoint mapper (dynamic port)...\n");

        status = RpcServerUseProtseq(
            (RPC_WSTR)L"ncacn_ip_tcp",
            RPC_C_PROTSEQ_MAX_REQS_DEFAULT,
            &sd
        );
        if (status != RPC_S_OK) {
            printf("RpcServerUseProtseq failed: 0x%x\n", status);
            return 1;
        }

        printf("Protocol sequence registered (dynamic port)\n");
    } else {
        printf("Starting RPC server on port %s...\n", port_arg);

        status = RpcServerUseProtseqEp(
            (RPC_WSTR)L"ncacn_ip_tcp",
            RPC_C_PROTSEQ_MAX_REQS_DEFAULT,
            (RPC_WSTR)port,
            &sd
        );
        if (status != RPC_S_OK) {
            printf("RpcServerUseProtseqEp failed: 0x%x\n", status);
            return 1;
        }

        printf("Protocol sequence registered on port %s\n", port_arg);
    }

    // Register interface
    status = RpcServerRegisterIf2(
        MyInterface_v1_0_s_ifspec,
        NULL,
        NULL,
        RPC_IF_ALLOW_CALLBACKS_WITH_NO_AUTH,
        RPC_C_LISTEN_MAX_CALLS_DEFAULT,
        (unsigned int)-1,
        NULL
    );
    if (status != RPC_S_OK) {
        printf("RpcServerRegisterIf2 failed: 0x%x\n", status);
        return 1;
    }
    printf("Interface registered successfully!\n");

    // If dynamic port: MUST query bindings and pass them to RpcEpRegister
    if (use_endpoint_mapper) {
        status = RpcServerInqBindings(&binding_vector);
        if (status != RPC_S_OK || !binding_vector) {
            printf("RpcServerInqBindings failed: 0x%x\n", status);
            return 1;
        }

        status = RpcEpRegister(
            MyInterface_v1_0_s_ifspec,
            binding_vector,
            NULL,
            (RPC_WSTR)L"RPC Command Executor Service"
        );

        if (status != RPC_S_OK) {
            printf("RpcEpRegister failed: 0x%x\n", status);
            // Not fatal for direct-binding clients, but fatal for discovery via EPM
        } else {
            ep_registered = TRUE;
            printf("Endpoints registered with endpoint mapper (EPM on port 135)\n");
        }

        // You can free the vector after registration
        RpcBindingVectorFree(&binding_vector);
        binding_vector = NULL;
    }

    printf("Server ready. Press Ctrl+C to stop.\n");

    status = RpcServerListen(1, RPC_C_LISTEN_MAX_CALLS_DEFAULT, FALSE);
    if (status != RPC_S_OK) {
        printf("RpcServerListen failed: 0x%x\n", status);

        if (use_endpoint_mapper && ep_registered) {
            RpcEpUnregister(MyInterface_v1_0_s_ifspec, NULL, NULL);
        }
        return 1;
    }

    // Cleanup (usually not reached with FALSE wait flag, but keep it correct)
    if (use_endpoint_mapper && ep_registered) {
        printf("Unregistering from endpoint mapper...\n");
        RpcEpUnregister(MyInterface_v1_0_s_ifspec, NULL, NULL);
    }

    return 0;
}

