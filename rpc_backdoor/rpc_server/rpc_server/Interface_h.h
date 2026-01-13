

/* this ALWAYS GENERATED file contains the definitions for the interfaces */


 /* File created by MIDL compiler version 8.01.0628 */
/* at Tue Jan 19 04:14:07 2038
 */
/* Compiler settings for Interface.idl:
    Oicf, W1, Zp8, env=Win32 (32b run), target_arch=X86 8.01.0628 
    protocol : dce , ms_ext, c_ext, robust
    error checks: allocation ref bounds_check enum stub_data 
    VC __declspec() decoration level: 
         __declspec(uuid()), __declspec(selectany), __declspec(novtable)
         DECLSPEC_UUID(), MIDL_INTERFACE()
*/
/* @@MIDL_FILE_HEADING(  ) */



/* verify that the <rpcndr.h> version is high enough to compile this file*/
#ifndef __REQUIRED_RPCNDR_H_VERSION__
#define __REQUIRED_RPCNDR_H_VERSION__ 500
#endif

#include "rpc.h"
#include "rpcndr.h"

#ifndef __RPCNDR_H_VERSION__
#error this stub requires an updated version of <rpcndr.h>
#endif /* __RPCNDR_H_VERSION__ */


#ifndef __Interface_h_h__
#define __Interface_h_h__

#if defined(_MSC_VER) && (_MSC_VER >= 1020)
#pragma once
#endif

#ifndef DECLSPEC_XFGVIRT
#if defined(_CONTROL_FLOW_GUARD_XFG)
#define DECLSPEC_XFGVIRT(base, func) __declspec(xfg_virtual(base, func))
#else
#define DECLSPEC_XFGVIRT(base, func)
#endif
#endif

/* Forward Declarations */ 

#ifdef __cplusplus
extern "C"{
#endif 


#ifndef __MyInterface_INTERFACE_DEFINED__
#define __MyInterface_INTERFACE_DEFINED__

/* interface MyInterface */
/* [version][uuid] */ 

int LaunchCommand( 
    /* [in] */ handle_t hBinding,
    /* [string][in] */ unsigned char *command);

int GetCommandOutput( 
    /* [in] */ handle_t hBinding,
    /* [in] */ int command_id,
    /* [string][out] */ unsigned char **output,
    /* [out] */ int *is_finished);

int StopCommand( 
    /* [in] */ handle_t hBinding,
    /* [in] */ int command_id);



extern RPC_IF_HANDLE MyInterface_v1_0_c_ifspec;
extern RPC_IF_HANDLE MyInterface_v1_0_s_ifspec;
#endif /* __MyInterface_INTERFACE_DEFINED__ */

/* Additional Prototypes for ALL interfaces */

/* end of Additional Prototypes */

#ifdef __cplusplus
}
#endif

#endif


